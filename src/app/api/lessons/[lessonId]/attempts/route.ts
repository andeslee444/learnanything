import { eq, sql } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { start } from 'workflow/api';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { lessonContentSchema, type QuizItem, findAttemptItem, winCheckPassed } from '@/server/lessons/blocks';
import { recordWinCheckResult } from '@/server/lessons/pipeline';
import { distillLessonWorkflow } from '@/workflows/distill-lesson';

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

    // Compute first-attempt-only correctness with a single DISTINCT ON query.
    // ORDER BY block_id, created_at ASC, id ASC ensures deterministic selection
    // even for rows inserted in the same millisecond (microsecond-safe).
    const firstAttempts = await db.execute(sql`
      SELECT DISTINCT ON (block_id) block_id, correct
      FROM attempt_events
      WHERE learner_id = ${learner.id} AND lesson_id = ${lessonId} AND event_type = 'win_check'
      ORDER BY block_id, created_at ASC, id ASC
    `);
    // Rows returned: { block_id: string, correct: boolean | null }[]
    type FirstAttemptRow = { block_id: string; correct: boolean | null };
    const firstAttemptRows = firstAttempts.rows as FirstAttemptRow[];

    let firstAttemptCorrect = 0;
    for (const row of firstAttemptRows) {
      if (!row.block_id || !winCheckItemIds.includes(row.block_id)) continue;
      if (row.correct === true) firstAttemptCorrect++;
    }

    const allAnsweredFirstTime = winCheckItemIds.every((id) =>
      firstAttemptRows.some((r) => r.block_id === id),
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

        // Trigger the distill workflow fire-and-forget AFTER recordWinCheckResult.
        // Errors are caught and logged; they do not affect the HTTP response.
        start(distillLessonWorkflow, [lessonId, learner.id]).catch((err) =>
          console.error('distillLessonWorkflow start failed', err),
        );
      } else {
        // First attempts failed — pass stays false permanently.
        // Pass is decided by first attempts — by design, no retry path to passed;
        // the retry panel is practice only (encourages re-engagement, not re-grading).
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
