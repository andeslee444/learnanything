import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { InsufficientCreditsError, ensureMonthlyGrant, placeHold } from '@/lib/credits';
import { getLearnerByUserId } from '@/server/learners';
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

  if (lesson.status !== 'failed') {
    return NextResponse.json({ error: 'lesson_not_failed' }, { status: 409 });
  }

  // Credit lifecycle: grant → new hold (402 on insufficient).
  await ensureMonthlyGrant(db, session.user.id);
  try {
    await placeHold(db, session.user.id, lessonId);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return NextResponse.json({ error: 'credits' }, { status: 402 });
    }
    throw err;
  }

  // Reset lesson to generating state with cleared content.
  await db
    .update(s.lessons)
    .set({ status: 'generating', content: null })
    .where(eq(s.lessons.id, lessonId));

  // Fire-and-forget.
  void start(generateLessonWorkflow, [lessonId]);

  return NextResponse.json({ lessonId });
}
