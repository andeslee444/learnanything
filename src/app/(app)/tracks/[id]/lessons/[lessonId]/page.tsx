import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { eq } from 'drizzle-orm';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { LessonView } from './lesson-view';

export default async function LessonPage({
  params,
}: {
  params: Promise<{ id: string; lessonId: string }>;
}) {
  const { id: trackId, lessonId } = await params;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) redirect('/signup');

  // Ownership: lesson → track → learner
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson) notFound();
  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, lesson.trackId));
  if (!track || track.learnerId !== learner.id || track.id !== trackId) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <nav className="mb-6">
        <Link
          href={`/tracks/${trackId}`}
          className="text-sm text-sky-600 hover:text-sky-700 underline underline-offset-2"
        >
          ← Back to learning map
        </Link>
      </nav>

      <h1 className="text-xl font-medium text-ink-900">
        {track.topic}
      </h1>

      <LessonView lessonId={lessonId} trackId={trackId} />
    </main>
  );
}
