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
import type Stripe from 'stripe';
import * as s from '@/db/schema';
import { alertFounder } from '@/lib/alerts';

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

/**
 * Confirms whether a billing_customers row that says 'active' is actually
 * active in Stripe. Used to self-heal stale-'active' drift caused by missed
 * customer.subscription.deleted webhooks (>72h endpoint outage).
 *
 * Returns:
 *   true  — live Stripe check confirms active sub (or we couldn't check: fail-closed)
 *   false — DB says 'active' but Stripe has no active sub → row healed to 'canceled'
 *
 * When false is returned the DB row has already been updated to 'canceled' and
 * alertFounder has been fired (content-free). Callers should PROCEED (skip the 409).
 *
 * Fail-closed cases (returns true, no heal):
 *   - stripe is null (no STRIPE_SECRET_KEY)
 *   - stripeCustomerId is null
 *   - Stripe API call throws
 */
export async function confirmActiveSubscription(
  db: Db,
  stripe: Stripe | null,
  billingCustomer: { stripeCustomerId: string | null },
): Promise<boolean> {
  // Fail-closed: can't check without stripe instance or customer id.
  if (!stripe || !billingCustomer.stripeCustomerId) return true;

  try {
    const subs = await stripe.subscriptions.list({
      customer: billingCustomer.stripeCustomerId,
      status: 'active',
      limit: 1,
    });
    if (subs.data.length === 0) {
      // Drift: DB says active but Stripe has no active subscription.
      // Heal the DB row and fire a content-free alert.
      await db
        .update(s.billingCustomers)
        .set({ subscriptionStatus: 'canceled', updatedAt: new Date() })
        .where(eq(s.billingCustomers.stripeCustomerId, billingCustomer.stripeCustomerId));
      alertFounder('billing', { note: 'status_drift_healed' });
      return false; // caller should proceed — no active sub
    }
    return true; // confirmed active
  } catch {
    // Stripe call failed — fail-closed: treat as still active.
    return true;
  }
}
