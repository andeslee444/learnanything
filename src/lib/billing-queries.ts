/**
 * Billing query helpers — Phase 9.
 *
 * Extracted so tests can exercise the real query logic against testDb
 * (no mocks, no tautologies).
 *
 * Exports:
 *   getLedgerHistory(db, userId, limit) — newest N ledger rows, safe for UI.
 *     Never leaks Stripe invoice IDs; returns a boolean `hasStripeRef` instead.
 *   getSubscriptionStatus(db, userId) — current subscription status or 'none'.
 */

import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;

export type LedgerRow = {
  id: string;
  entryType: string;
  amount: number;
  hasStripeRef: boolean;
  createdAt: Date;
};

/**
 * Returns the newest `limit` credit-ledger rows for a user, suitable for
 * display in the billing UI.
 *
 * Stripe internal IDs (stripeRef) are NOT returned — instead `hasStripeRef`
 * is a boolean so the UI can show "Stripe payment" without leaking the ID.
 */
export async function getLedgerHistory(
  db: Db,
  userId: string,
  limit = 25,
): Promise<LedgerRow[]> {
  const rows = await db
    .select({
      id: s.creditLedger.id,
      entryType: s.creditLedger.entryType,
      amount: s.creditLedger.amount,
      stripeRef: s.creditLedger.stripeRef,
      createdAt: s.creditLedger.createdAt,
    })
    .from(s.creditLedger)
    .where(eq(s.creditLedger.userId, userId))
    .orderBy(desc(s.creditLedger.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    entryType: r.entryType,
    amount: r.amount,
    hasStripeRef: r.stripeRef != null,
    createdAt: r.createdAt,
  }));
}

/**
 * Returns the subscription status for a user, or 'none' if no
 * billing_customers row exists.
 */
export async function getSubscriptionStatus(
  db: Db,
  userId: string,
): Promise<'none' | 'active' | 'canceled'> {
  const [row] = await db
    .select({ subscriptionStatus: s.billingCustomers.subscriptionStatus })
    .from(s.billingCustomers)
    .where(eq(s.billingCustomers.userId, userId))
    .limit(1);
  return row?.subscriptionStatus ?? 'none';
}
