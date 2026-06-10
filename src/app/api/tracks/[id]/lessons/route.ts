import { eq, and } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { InsufficientCreditsError, ensureMonthlyGrant, placeHold } from '@/lib/credits';
import { getLearnerByUserId } from '@/server/learners';
import { getTrackDetail } from '@/server/tracks';
import { createLessonRow } from '@/server/lessons/pipeline';
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

  // Reject if a lesson is already generating on this track.
  const [generating] = await db
    .select({ id: s.lessons.id })
    .from(s.lessons)
    .where(and(eq(s.lessons.trackId, id), eq(s.lessons.status, 'generating')))
    .limit(1);
  if (generating) {
    return NextResponse.json({ error: 'lesson_already_generating' }, { status: 409 });
  }

  // Credit lifecycle: grant → hold (402 on insufficient).
  await ensureMonthlyGrant(db, session.user.id);
  const lesson = await createLessonRow(db, id);
  try {
    await placeHold(db, session.user.id, lesson.id);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      // Clean up the row we just created — 402 before any model spend.
      await db.delete(s.lessons).where(eq(s.lessons.id, lesson.id));
      return NextResponse.json({ error: 'credits' }, { status: 402 });
    }
    throw err;
  }

  // Fire-and-forget: the client polls GET /api/lessons/[id].
  void start(generateLessonWorkflow, [lesson.id]);

  return NextResponse.json({ lessonId: lesson.id });
}
