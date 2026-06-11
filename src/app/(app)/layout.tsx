import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getLearnerByUserId } from '@/server/learners';
import { getDueCount } from '@/lib/reviews';
import { SignOutButton } from '@/components/signout-button';
import { SessionNudge } from '@/components/session-nudge';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) redirect('/signup'); // orphan user (signup interrupted) — completes profile there

  // Cheap indexed count — uses review_cards_learner_due index
  const dueCount = await getDueCount(db, learner.id);

  return (
    <div className="min-h-screen bg-cloud">
      <header className="flex items-center justify-between border-b border-ink-400/20 px-6 py-4">
        <Link href="/tracks" className="text-lg font-medium text-sky-700">LearnAnything</Link>
        <nav aria-label="Site navigation" className="flex items-center gap-4">
          {dueCount > 0 && (
            <Link
              href="/reviews"
              data-testid="reviews-badge"
              className="flex items-center gap-1.5 rounded-full bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              aria-label={`${dueCount} review${dueCount === 1 ? '' : 's'} due`}
            >
              <span aria-hidden="true">📚</span>
              {dueCount} due
            </Link>
          )}
          <SignOutButton />
        </nav>
      </header>
      {children}
      <SessionNudge />
    </div>
  );
}
