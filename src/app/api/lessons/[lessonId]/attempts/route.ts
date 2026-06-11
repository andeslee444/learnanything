import { and, eq, min } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { lessonContentSchema, type QuizItem, findAttemptItem, winCheckPassed } from '@/server/lessons/blocks';
import { recordWinCheckResult } from '@/server/lessons/pipeline';
import { distillLesson } from '@/server/lessons/distiller';

const bodySchema = z.object({
  itemId: z.string().min(1),
  answerIndex: z.number().int().min(0).max(3),
  kind: z.enum(['opener', 'quiz', 'win_check']),
});

export async function POST(req: Request, ctx: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await ctx.params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });

  // Ownership: lesson → track → learner
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, lesson.trackId));
  if (!track || track.learnerId !== learner.id) return NextResponse.json({ error: 'not found' }, { status: 404 });

  if (lesson.status !== 'ready') {
    return NextResponse.json({ error: 'lesson_not_ready' }, { status: 409 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const { itemId, answerIndex, kind } = parsed.data;

  // Parse the lesson content to look up the item server-side.
  const contentParse = lessonContentSchema.safeParse(
    // content has openerItems beyond schema — strip is fine here, we use it below
    lesson.content
  );
  if (!contentParse.success) {
    return NextResponse.json({ error: 'lesson content unavailable' }, { status: 500 });
  }
  const content = contentParse.data;
  const rawContent = lesson.content as Record<string, unknown>;
  const openerItems = Array.isArray(rawContent.openerItems) ? (rawContent.openerItems as QuizItem[]) : [];

  // Augment content with openerItems for helper function (not in schema).
  const contentWithOpeners = { ...content, openerItems };

  // Find the item in the appropriate location.
  const item = findAttemptItem(contentWithOpeners, kind, itemId);

  if (!item) return NextResponse.json({ error: 'item_not_found' }, { status: 404 });

  const correct = answerIndex === item.correctIndex;
  const eventType = kind === 'win_check' ? 'win_check' : 'quiz_answer';

  // Convention: attempt_events.blockId stores ITEM ids (not block-level ids).
  await db.insert(s.attemptEvents).values({
    learnerId: learner.id,
    lessonId,
    blockId: itemId,
    eventType,
    correct,
    payload: { lessonId, itemId, answerIndex },
  });

  // Win-check evaluation: first-attempt-only grading.
  // Pass is decided by first attempts only — re-answering is allowed for practice but
  // does not change the verdict. The distiller is the evidence authority for mastery;
  // recordWinCheckResult keeps its immediate cache write for snappy UX.
  if (kind === 'win_check') {
    const winCheckItemIds = content.winCheck.items.map((qi) => qi.id);
    const total = winCheckItemIds.length;

    // Compute first-attempt-only correctness:
    // For each win_check item, find the earliest attempt_event (min created_at per itemId),
    // then count how many of those first attempts were correct.
    const firstAttemptRows = await db
      .select({
        blockId: s.attemptEvents.blockId,
        minCreatedAt: min(s.attemptEvents.createdAt),
      })
      .from(s.attemptEvents)
      .where(
        and(
          eq(s.attemptEvents.learnerId, learner.id),
          eq(s.attemptEvents.lessonId, lessonId),
          eq(s.attemptEvents.eventType, 'win_check'),
        ),
      )
      .groupBy(s.attemptEvents.blockId);

    // For each item, look up the correct value at the min createdAt.
    // We do this by fetching each first-attempt row.
    let firstAttemptCorrect = 0;
    for (const { blockId, minCreatedAt } of firstAttemptRows) {
      if (!blockId || !winCheckItemIds.includes(blockId)) continue;
      if (!minCreatedAt) continue;

      // Fetch the first attempt row to check correctness
      const [firstRow] = await db
        .select({ correct: s.attemptEvents.correct })
        .from(s.attemptEvents)
        .where(
          and(
            eq(s.attemptEvents.learnerId, learner.id),
            eq(s.attemptEvents.lessonId, lessonId),
            eq(s.attemptEvents.eventType, 'win_check'),
            eq(s.attemptEvents.blockId, blockId),
            eq(s.attemptEvents.createdAt, minCreatedAt),
          ),
        )
        .limit(1);

      if (firstRow?.correct === true) {
        firstAttemptCorrect++;
      }
    }

    const allAnsweredFirstTime = winCheckItemIds.every((id) =>
      firstAttemptRows.some((r) => r.blockId === id),
    );

    // Pass verdict is based on first-attempt scores only.
    // We only evaluate once all items have a first attempt recorded.
    let winCheckResult: { answered: number; total: number; passed?: boolean } = {
      answered: firstAttemptCorrect,
      total,
    };

    if (allAnsweredFirstTime) {
      const passed = winCheckPassed(firstAttemptCorrect, total);
      if (passed) {
        // recordWinCheckResult keeps its immediate cache write for snappy UX.
        // The distiller is the evidence authority; it runs after this.
        await recordWinCheckResult(db, lessonId, firstAttemptCorrect, total);
        winCheckResult = { answered: firstAttemptCorrect, total, passed: true };

        // Trigger the distiller fire-and-forget AFTER recordWinCheckResult.
        // Errors are caught and logged; they do not affect the HTTP response.
        distillLesson(db, { lessonId, learnerId: learner.id }).catch((err) =>
          console.error('distillLesson failed', err),
        );
      } else {
        // First attempts failed — pass stays false.
        // The retry-encouragement UX appears; re-answering is allowed for practice
        // but pass verdict is final (first-attempt evidence is already recorded).
        winCheckResult = { answered: firstAttemptCorrect, total, passed: false };
      }
    }
    // If not all items have a first attempt yet, winCheck has no passed field
    // so the client shows progress without triggering the win panel.

    return NextResponse.json({
      correct,
      explanation: item.explanation,
      winCheck: winCheckResult,
    });
  }

  return NextResponse.json({ correct, explanation: item.explanation });
}
