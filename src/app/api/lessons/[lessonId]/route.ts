import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';

export async function GET(_req: Request, ctx: { params: Promise<{ lessonId: string }> }) {
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

  // TODO(phase-4b): strip correctIndex from content before sending — the answer key is readable in the network tab; requires the post-answer highlight to rely on the attempts response alone.
  const content = lesson.status === 'ready' ? lesson.content : undefined;
  const failureReason =
    lesson.status === 'failed' && lesson.content && typeof lesson.content === 'object'
      ? (lesson.content as Record<string, unknown>).failureReason
      : undefined;

  return NextResponse.json({
    status: lesson.status,
    spec: lesson.spec,
    content,
    citations: lesson.citations,
    ...(failureReason !== undefined ? { failureReason } : {}),
  });
}
