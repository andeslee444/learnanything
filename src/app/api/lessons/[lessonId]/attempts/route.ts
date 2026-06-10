import { and, count, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { lessonContentSchema, type QuizItem } from '@/server/lessons/blocks';
import { recordWinCheckResult } from '@/server/lessons/pipeline';

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

  // Find the item in the appropriate location.
  let item: QuizItem | undefined;
  if (kind === 'opener') {
    item = openerItems.find((qi) => qi.id === itemId);
  } else if (kind === 'quiz') {
    for (const block of content.blocks) {
      if (block.type === 'quiz') {
        const found = block.items.find((qi) => qi.id === itemId);
        if (found) { item = found; break; }
      }
    }
  } else {
    // win_check
    item = content.winCheck.items.find((qi) => qi.id === itemId);
  }

  if (!item) return NextResponse.json({ error: 'item_not_found' }, { status: 404 });

  const correct = answerIndex === item.correctIndex;
  const eventType = kind === 'win_check' ? 'win_check' : 'quiz_answer';

  await db.insert(s.attemptEvents).values({
    learnerId: learner.id,
    lessonId,
    blockId: itemId,
    eventType,
    correct,
    payload: { lessonId, itemId, answerIndex },
  });

  // Win-check evaluation: count this learner's distinct CORRECT win_check answers for this lesson.
  if (kind === 'win_check') {
    const winCheckItemIds = content.winCheck.items.map((qi) => qi.id);
    const total = winCheckItemIds.length;

    // Count distinct item ids answered correctly (re-answering is allowed; take the latest per item).
    // Strategy: count rows where correct=true and blockId is in winCheckItemIds.
    // We include the just-inserted row, so correct answers are all accumulated.
    const [{ correctCount }] = await db
      .select({ correctCount: count() })
      .from(s.attemptEvents)
      .where(
        and(
          eq(s.attemptEvents.learnerId, learner.id),
          eq(s.attemptEvents.lessonId, lessonId),
          eq(s.attemptEvents.eventType, 'win_check'),
          eq(s.attemptEvents.correct, true),
        ),
      );

    // Distinct correct items (a learner could answer same item correctly multiple times).
    // We need distinct blockIds with correct=true.
    const correctItems = await db
      .selectDistinct({ blockId: s.attemptEvents.blockId })
      .from(s.attemptEvents)
      .where(
        and(
          eq(s.attemptEvents.learnerId, learner.id),
          eq(s.attemptEvents.lessonId, lessonId),
          eq(s.attemptEvents.eventType, 'win_check'),
          eq(s.attemptEvents.correct, true),
        ),
      );
    // Only count items that are actually in the win-check (guard against stale data).
    const distinctCorrect = correctItems.filter((r) => r.blockId && winCheckItemIds.includes(r.blockId)).length;
    const allAnswered = distinctCorrect >= total;

    let winCheckResult: { answered: number; total: number; passed?: boolean } = {
      answered: distinctCorrect,
      total,
    };

    if (allAnswered) {
      const result = await recordWinCheckResult(db, lessonId, distinctCorrect, total);
      winCheckResult = { answered: distinctCorrect, total, passed: result.passed };
    }

    void correctCount; // used above only for context; distinctCorrect is authoritative

    return NextResponse.json({
      correct,
      explanation: item.explanation,
      winCheck: winCheckResult,
    });
  }

  return NextResponse.json({ correct, explanation: item.explanation });
}
