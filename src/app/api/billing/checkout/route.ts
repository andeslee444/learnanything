/**
 * POST /api/billing/checkout
 *
 * Creates a Stripe Checkout Session for the monthly subscription.
 * Auth: session only (no learner profile required — root of the session ladder).
 * Returns 503 + BillingUnavailable shape when STRIPE_SECRET_KEY or STRIPE_PRICE_ID unset.
 *
 * Upfront customer creation: we create (or reuse) a Stripe customer BEFORE
 * the checkout session so the billing_customers row exists prior to any
 * webhook event firing — eliminates the ordering dependency that caused lost
 * grants when invoice.paid arrived before checkout.session.completed.
 *
 * Exports:
 *   createCheckoutHandler(db) — factory that returns a POST handler wired to
 *                               the given db; mirrors webhook's createPostHandler
 *                               pattern; used by tests to inject testDb.
 *   POST                       — production handler, uses the shared db pool.
 */

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getStripe } from '@/lib/stripe';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

type Db = NodePgDatabase<typeof s>;

export function createCheckoutHandler(database: Db) {
  return async function POST() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const stripe = getStripe();
    if (!stripe) {
      return NextResponse.json({ error: 'BillingUnavailable' }, { status: 503 });
    }

    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      return NextResponse.json({ error: 'BillingUnavailable' }, { status: 503 });
    }

    const userId = session.user.id;

    // Look up existing billing_customers row for this user.
    const [existing] = await database
      .select({
        stripeCustomerId: s.billingCustomers.stripeCustomerId,
        subscriptionStatus: s.billingCustomers.subscriptionStatus,
      })
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, userId))
      .limit(1);

    // Already active subscriber — UI should route to portal instead.
    if (existing?.subscriptionStatus === 'active') {
      return NextResponse.json({ error: 'already_subscribed' }, { status: 409 });
    }

    let stripeCustomerId: string;

    if (existing?.stripeCustomerId) {
      // Reuse the existing Stripe customer — do NOT mint a second one.
      stripeCustomerId = existing.stripeCustomerId;
    } else {
      // Create a new Stripe customer and persist the mapping upfront so webhook
      // events (invoice.paid) can resolve userId without relying on
      // checkout.session.completed arriving first.
      const customer = await stripe.customers.create({
        email: session.user.email,
        metadata: { userId },
      });
      stripeCustomerId = customer.id;

      // INSERT with onConflictDoUpdate: if a row already exists (race), only
      // overwrite stripeCustomerId when it was previously null — never clobber
      // an existing customer id. CRITICAL: the checkout session must be created
      // on the WINNING row's customer id, not the locally-minted one — otherwise
      // a concurrent-checkout loser pays on a customer the webhook can't resolve
      // and receives zero credits for the life of the subscription.
      const [winner] = await database
        .insert(s.billingCustomers)
        .values({
          userId,
          stripeCustomerId,
          subscriptionStatus: 'none',
        })
        .onConflictDoUpdate({
          target: s.billingCustomers.userId,
          set: {
            // Only update stripeCustomerId when the existing value is NULL.
            stripeCustomerId: sql`CASE WHEN ${s.billingCustomers.stripeCustomerId} IS NULL THEN EXCLUDED.stripe_customer_id ELSE ${s.billingCustomers.stripeCustomerId} END`,
            updatedAt: new Date(),
          },
        })
        .returning({ stripeCustomerId: s.billingCustomers.stripeCustomerId });
      stripeCustomerId = winner.stripeCustomerId;
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      success_url: `${APP_URL}/billing?success=1`,
      cancel_url: `${APP_URL}/billing`,
    });

    return NextResponse.json({ url: checkoutSession.url });
  };
}

// ── Production export ─────────────────────────────────────────────────────────

export const POST = createCheckoutHandler(db);
