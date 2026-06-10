import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getLearnerByUserId } from '@/server/learners';
import { listTracks } from '@/server/tracks';

export default async function TracksPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) redirect('/signup');

  const tracks = await listTracks(db, learner.id);

  if (tracks.length === 0) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-6 py-12">
        <Link
          href="/tracks/new"
          data-testid="new-track"
          className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-sky-300 bg-sky-50 px-12 py-14 text-center transition hover:border-sky-400 hover:bg-sky-100"
          aria-label="Start a new track"
        >
          <span className="text-4xl">🗺️</span>
          <h1 className="text-2xl font-medium text-sky-700">What do you want to learn?</h1>
          <p className="text-sky-600">Create your first learning track to get started.</p>
        </Link>
      </main>
    );
  }

  return (
    <main className="px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-medium text-ink-900">Your tracks</h1>
        <Link
          href="/tracks/new"
          data-testid="new-track"
          className="rounded-xl bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700"
          aria-label="Create a new track"
        >
          + New track
        </Link>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tracks.map((track) => (
          <Link
            key={track.id}
            href={`/tracks/${track.id}`}
            data-testid="track-card"
            className="flex flex-col gap-3 rounded-xl border border-ink-400/20 bg-cloud p-5 shadow-sm transition hover:border-sky-300 hover:shadow-md"
            aria-label={`Track: ${track.topic}`}
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-base font-medium text-ink-900 line-clamp-2">{track.topic}</h2>
              <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 capitalize">
                {track.vertical}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-sun-100 px-2 py-0.5 text-xs font-medium text-sun-700 capitalize">
                {track.status}
              </span>
            </div>
            <p className="mt-auto text-xs text-ink-400">
              Started {new Date(track.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
