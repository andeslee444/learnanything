import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getLearnerByUserId } from '@/server/learners';
import { getDueCards, assembleReviewItem } from '@/lib/reviews';

/**
 * GET /api/reviews/due
 *
 * Returns MC review items for cards due today.
 * correctIndex is intentionally omitted from the response — the POST grade
 * route recomputes it deterministically server-side from the card id.
 */
export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });

  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 50) : 20;

  const now = new Date();
  const dueCards = await getDueCards(db, learner.id, now, limit);

  // Assemble MC items — strip correctIndex before sending to client
  const items = await Promise.all(
    dueCards.map(async (card) => {
      const item = await assembleReviewItem(db, card);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { correctIndex: _ci, ...clientItem } = item;
      return clientItem;
    }),
  );

  return NextResponse.json({ items });
}
