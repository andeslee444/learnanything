import { and, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { InsufficientCreditsError, ensureMonthlyGrant, placeHold } from '@/lib/credits';
import { getLearnerByUserId } from '@/server/learners';
import { failLessonSafely } from '@/server/lessons/pipeline';
import { generateLessonWorkflow } from '@/workflows/generate-lesson';

export async function POST(_req: Request, ctx: { params: Promise<{ lessonId: string }> }) {
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

  // C3: CAS flip first — atomically claim the failed lesson before any credit work.
  const flipped = await db
    .update(s.lessons)
    .set({ status: 'generating', content: null })
    .where(and(eq(s.lessons.id, lessonId), eq(s.lessons.status, 'failed')))
    .returning({ id: s.lessons.id });
  if (flipped.length === 0) {
    return NextResponse.json({ error: 'lesson_not_failed' }, { status: 409 });
  }

  // Credit lifecycle + workflow start. Any error other than InsufficientCreditsError
  // reverts the CAS flip so the lesson is not orphaned in 'generating' state.
  try {
    await ensureMonthlyGrant(db, session.user.id);
    try {
      await placeHold(db, session.user.id, lessonId);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        // Revert the CAS flip so the lesson remains retryable.
        await db
          .update(s.lessons)
          .set({ status: 'failed' })
          .where(and(eq(s.lessons.id, lessonId), eq(s.lessons.status, 'generating')));
        return NextResponse.json({ error: 'credits' }, { status: 402 });
      }
      throw err;
    }

    // C1: start with catch to mark lesson failed rather than orphaning it.
    start(generateLessonWorkflow, [lessonId]).catch(async (err) => {
      console.error('workflow start failed', err);
      await failLessonSafely(db, lessonId, 'generation error — try again');
    });
  } catch (err) {
    // Non-credit error: revert the CAS flip so the lesson doesn't sit orphaned
    // in 'generating' state — mirrors the orphan cleanup in the create route.
    await db
      .update(s.lessons)
      .set({ status: 'failed' })
      .where(and(eq(s.lessons.id, lessonId), eq(s.lessons.status, 'generating')));
    throw err;
  }

  return NextResponse.json({ lessonId });
}
