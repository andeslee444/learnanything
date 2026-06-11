/**
 * GET /api/cron/review-digest
 *
 * Cron-guarded (Vercel cron: 0 13 * * * — 1 PM UTC daily).
 * Bearer authorization: Authorization: Bearer ${CRON_SECRET}.
 *
 * Finds learners with due review cards and emails each one a count digest.
 * Content discipline: only counts and the /reviews path are included — no card
 * content, no terms, no lesson text.
 */

import { NextResponse } from 'next/server';
import { count, eq, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db as appDb } from '@/lib/db';
import * as s from '@/db/schema';
import { sendEmail } from '@/lib/email';

type Db = NodePgDatabase<typeof s>;

export interface ReviewDigestResult {
  recipients: number;
  sent: number;
}

/**
 * Core query + send loop — exported for direct test invocation.
 *
 * Finds all learners with ≥1 review card due ≤ now, groups by learner,
 * and emails each one: "You have N reviews ready" (+ /reviews path in text).
 */
export async function runReviewDigest(db: Db, now: Date = new Date()): Promise<ReviewDigestResult> {
  // Group review cards by learner — count cards due now per learner.
  const rows = await db
    .select({
      learnerId: s.reviewCards.learnerId,
      dueCount: count(s.reviewCards.id),
      userEmail: s.user.email,
    })
    .from(s.reviewCards)
    .innerJoin(s.learners, eq(s.reviewCards.learnerId, s.learners.id))
    .innerJoin(s.user, eq(s.learners.userId, s.user.id))
    .where(lte(s.reviewCards.due, now))
    .groupBy(s.reviewCards.learnerId, s.user.email);

  // Filter to learners with at least 1 due card (count > 0 ensured by the WHERE).
  const recipients = rows.length;
  let sent = 0;

  for (const row of rows) {
    const n = Number(row.dueCount);
    if (n < 1) continue;
    const result = await sendEmail({
      to: row.userEmail,
      subject: `You have ${n} review${n === 1 ? '' : 's'} ready on LearnAnything`,
      // Content discipline: counts and path only — no card content.
      text: `You have ${n} review card${n === 1 ? '' : 's'} due. Open your reviews: /reviews`,
    }).catch(() => null);
    if (result?.sent || result?.transport === 'log') sent++;
  }

  return { recipients, sent };
}

export async function GET(req: Request) {
  // Auth guard: fail closed — 401 when CRON_SECRET unset or wrong.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 401 });
  }
  const authHeader = req.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (bearer !== cronSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = await runReviewDigest(appDb);
  return NextResponse.json({ ok: true, ...result });
}
