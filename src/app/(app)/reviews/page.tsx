import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getLearnerByUserId } from '@/server/learners';
import { getDueCards, assembleReviewItem } from '@/lib/reviews';
import { ReviewSession } from './review-session';

export const dynamic = 'force-dynamic';

export default async function ReviewsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) redirect('/signup');

  const now = new Date();
  const dueCards = await getDueCards(db, learner.id, now, 20);

  // Assemble MC items server-side; strip correctIndex before passing to client
  const clientItems = await Promise.all(
    dueCards.map(async (card) => {
      const item = await assembleReviewItem(db, card);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { correctIndex: _ci, ...clientItem } = item;
      return clientItem;
    }),
  );

  // Empty state
  if (clientItems.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12 text-center">
        <div className="text-5xl mb-4" aria-hidden="true">☀️</div>
        <h1 className="text-xl font-semibold text-ink-900">Nothing due — come back tomorrow</h1>
        <p className="mt-3 text-sm text-ink-600">
          Your next review will appear here when it&apos;s time to revisit a term.
          Keep learning to unlock more cards!
        </p>
        <Link
          href="/tracks"
          className="mt-6 inline-block rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Back to learning
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-xl font-semibold text-ink-900 mb-6">
        Review — {clientItems.length} card{clientItems.length === 1 ? '' : 's'} due
      </h1>
      <ReviewSession initialItems={clientItems} />
    </main>
  );
}
