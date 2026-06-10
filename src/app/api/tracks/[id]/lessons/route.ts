import { eq, sql } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { InsufficientCreditsError, ensureMonthlyGrant, placeHold } from '@/lib/credits';
import { getLearnerByUserId } from '@/server/learners';
import { getTrackDetail } from '@/server/tracks';
import { createLessonRow, failLessonSafely } from '@/server/lessons/pipeline';
import { generateLessonWorkflow } from '@/workflows/generate-lesson';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });
  const detail = await getTrackDetail(db, id, learner.id);
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Reject if track has zero skill nodes (not yet initialized).
  const nodes = await db.select().from(s.skillNodes).where(eq(s.skillNodes.trackId, id)).limit(1);
  if (nodes.length === 0) {
    return NextResponse.json({ error: 'track_not_initialized' }, { status: 409 });
  }

  // Credit lifecycle: grant → hold (402 on insufficient).
  await ensureMonthlyGrant(db, session.user.id);

  // I1: createLessonRow may violate lessons_one_generating_per_track → 409.
  let lesson: Awaited<ReturnType<typeof createLessonRow>>;
  try {
    lesson = await createLessonRow(db, id);
  } catch (err) {
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('lessons_one_generating_per_track') || causeMsg.includes('lessons_one_generating_per_track')) {
      return NextResponse.json({ error: 'already_generating' }, { status: 409 });
    }
    throw err;
  }

  try {
    await placeHold(db, session.user.id, lesson.id);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      // Clean up the row we just created — 402 before any model spend.
      await db.delete(s.lessons).where(eq(s.lessons.id, lesson.id));
      return NextResponse.json({ error: 'credits' }, { status: 402 });
    }
    // I2: unexpected error after row exists — delete orphan before rethrowing.
    await db.delete(s.lessons).where(eq(s.lessons.id, lesson.id));
    throw err;
  }

  // C1: start with catch to mark lesson failed rather than orphaning it.
  // Persist runId in zpdSnapshot so the stream route can look it up later.
  // Atomic jsonb merge avoids a read-merge-write race.
  start(generateLessonWorkflow, [lesson.id]).then(async (run) => {
    try {
      await db
        .update(s.lessons)
        .set({ zpdSnapshot: sql`zpd_snapshot || ${JSON.stringify({ workflowRunId: run.runId })}::jsonb` })
        .where(eq(s.lessons.id, lesson.id));
    } catch (err) {
      console.error('failed to persist workflowRunId', err);
    }
  }).catch(async (err) => {
    console.error('workflow start failed', err);
    await failLessonSafely(db, lesson.id, 'generation error — try again');
  });

  return NextResponse.json({ lessonId: lesson.id });
}
