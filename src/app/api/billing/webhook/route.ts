/**
 * POST /api/billing/webhook
 *
 * Stripe webhook endpoint. Reads raw body (MUST NOT json() first) and verifies
 * the Stripe-Signature header. Returns 503 when STRIPE_SECRET_KEY or
 * STRIPE_WEBHOOK_SECRET are unset; 400 on bad signature.
 *
 * Handled events:
 *   checkout.session.completed  — verify userId exists, upsert billing_customers
 *                                  (NO credit grant — invoice.paid is the money event)
 *   invoice.paid                — grant subscription credits ONLY for billing_reason
 *                                  'subscription_create' or 'subscription_cycle';
 *                                  idempotency key = invoice.id (not event.id)
 *   customer.subscription.deleted — mark status 'canceled' (no ledger row)
 *   everything else             — 200 {received:true}
 *
 * Design rationale:
 *   Stripe fires BOTH checkout.session.completed AND invoice.paid (billing_reason
 *   'subscription_create') for a subscription's first payment. Granting in
 *   checkout.session.completed → 60 credits instead of 30 (double-grant). The fix:
 *   grant ONLY in invoice.paid, keyed on invoice.id. The billing_customers row is
 *   created upfront in the checkout route, so the stripeCustomerId → userId lookup
 *   always succeeds regardless of event ordering.
 *
 * Exports:
 *   handleStripeEvent(db, event) — testable without HTTP/signature concerns
 *   createPostHandler(db)        — factory that returns a POST handler wired to
 *                                  the given db; used by tests to inject testDb
 *                                  while still exercising signature verification
 *   POST                         — production handler, uses the shared db pool
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getStripe } from '@/lib/stripe';
import { grantSubscriptionCredits } from '@/lib/credits';
import { alertFounder } from '@/lib/alerts';

// ── Exported handler (testable without HTTP concerns) ───────────────────────

type Db = NodePgDatabase<typeof s>;

export async function handleStripeEvent(
  database: Db,
  event: Stripe.Event
): Promise<{ status: number; body: unknown }> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      const stripeCustomerId =
        typeof session.customer === 'string' ? session.customer : session.customer?.id;

      if (!userId || !stripeCustomerId) {
        // Unexpected shape — log and ack so Stripe doesn't retry.
        alertFounder('billing', { eventType: event.type, note: 'missing_fields' });
        return { status: 200, body: { received: true } };
      }

      // Verify the userId actually exists — unverified client_reference_id could
      // be tampered or belong to a deleted account; inserting it would FK-violate.
      const [userRow] = await database
        .select({ id: s.user.id })
        .from(s.user)
        .where(eq(s.user.id, userId))
        .limit(1);

      if (!userRow) {
        // Unknown user — alert and ack (content-free: no PII in payload).
        alertFounder('billing', { eventType: event.type, note: 'unknown_user' });
        return { status: 200, body: { received: true } };
      }

      // Upsert billing_customers row.
      // If a row already exists with a different stripeCustomerId (customer_mismatch),
      // keep the existing id and alert the founder — do NOT overwrite it.
      const [existing] = await database
        .select({ stripeCustomerId: s.billingCustomers.stripeCustomerId })
        .from(s.billingCustomers)
        .where(eq(s.billingCustomers.userId, userId))
        .limit(1);

      if (existing && existing.stripeCustomerId !== stripeCustomerId) {
        alertFounder('billing', { eventType: event.type, note: 'customer_mismatch' });
        // Keep existing stripeCustomerId — only update subscriptionStatus.
        await database
          .update(s.billingCustomers)
          .set({ subscriptionStatus: 'active', updatedAt: new Date() })
          .where(eq(s.billingCustomers.userId, userId));
      } else {
        // Normal path: upsert with the current stripeCustomerId.
        await database
          .insert(s.billingCustomers)
          .values({
            userId,
            stripeCustomerId,
            subscriptionStatus: 'active',
          })
          .onConflictDoUpdate({
            target: s.billingCustomers.userId,
            set: {
              stripeCustomerId,
              subscriptionStatus: 'active',
              updatedAt: new Date(),
            },
          });
      }

      // NO credit grant here. Credits are granted exclusively in invoice.paid
      // (billing_reason subscription_create|subscription_cycle), keyed on invoice.id.
      // This eliminates the double-grant that occurred when both events granted
      // with their own event.id keys.

      return { status: 200, body: { received: true } };
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;

      // Guard: only grant for subscription payments, not dashboard one-offs or
      // future SKUs. billing_reason 'subscription_create' = first payment;
      // 'subscription_cycle' = renewal. Anything else → ack, no grant.
      const billingReason = invoice.billing_reason;
      if (billingReason !== 'subscription_create' && billingReason !== 'subscription_cycle') {
        return { status: 200, body: { received: true } };
      }

      const stripeCustomerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

      if (!stripeCustomerId) {
        alertFounder('billing', { eventType: event.type, note: 'missing_customer' });
        return { status: 200, body: { received: true } };
      }

      // Resolve user from stripeCustomerId.
      // The checkout route creates billing_customers upfront, so a missing row
      // here means a foreign/garbage customer id — not a race condition.
      const [customer] = await database
        .select({ userId: s.billingCustomers.userId })
        .from(s.billingCustomers)
        .where(eq(s.billingCustomers.stripeCustomerId, stripeCustomerId))
        .limit(1);

      if (!customer) {
        alertFounder('billing', { eventType: event.type, note: 'unknown_customer' });
        return { status: 200, body: { received: true } };
      }

      // Grant subscription credits.
      // Idempotency key = invoice.id (the money object), NOT event.id.
      // This means both a duplicate delivery of the same event AND two different
      // event envelopes wrapping the same invoice both resolve to ONE ledger row.
      await grantSubscriptionCredits(database, customer.userId, invoice.id);

      // Ensure status is 'active' — covers invoice.paid arriving before
      // checkout.session.completed (ordering race), so a paying user is never
      // stuck with status 'none'.
      await database
        .update(s.billingCustomers)
        .set({ subscriptionStatus: 'active', updatedAt: new Date() })
        .where(eq(s.billingCustomers.stripeCustomerId, stripeCustomerId));

      return { status: 200, body: { received: true } };
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const stripeCustomerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id ?? null;

      if (stripeCustomerId) {
        // Mark canceled — keep any remaining credits in the ledger.
        await database
          .update(s.billingCustomers)
          .set({ subscriptionStatus: 'canceled', updatedAt: new Date() })
          .where(eq(s.billingCustomers.stripeCustomerId, stripeCustomerId));
      }

      return { status: 200, body: { received: true } };
    }

    default:
      // Unhandled event type — ack so Stripe doesn't retry.
      return { status: 200, body: { received: true } };
  }
}

// ── Route handler factory (raw body + signature verification) ────────────────

/**
 * Returns a POST handler bound to the given database.
 * The production export uses the shared pool; tests inject testDb.
 */
export function createPostHandler(database: Db) {
  return async function POST(req: NextRequest) {
    const stripe = getStripe();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripe || !webhookSecret) {
      return NextResponse.json({ error: 'BillingUnavailable' }, { status: 503 });
    }

    const raw = await req.text();
    const sig = req.headers.get('stripe-signature') ?? '';

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
    } catch {
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }

    try {
      const result = await handleStripeEvent(database, event);
      return NextResponse.json(result.body, { status: result.status });
    } catch {
      // Never echo Stripe/DB error details to the response — keeps Stripe
      // retrying genuine transient failures while garbage is acked inside
      // the handler.
      console.error('[billing-webhook] unhandled error processing event', event.id);
      return NextResponse.json({ error: 'internal' }, { status: 500 });
    }
  };
}

// ── Production export ─────────────────────────────────────────────────────────

export const POST = createPostHandler(db);
