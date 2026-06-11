/**
 * POST /api/billing/webhook
 *
 * Stripe webhook endpoint. Reads raw body (MUST NOT json() first) and verifies
 * the Stripe-Signature header. Returns 503 when STRIPE_SECRET_KEY or
 * STRIPE_WEBHOOK_SECRET are unset; 400 on bad signature.
 *
 * Handled events:
 *   checkout.session.completed  — upsert billing_customers, grant credits
 *   invoice.paid                — grant renewal credits (stripeRef = event.id)
 *   customer.subscription.deleted — mark status 'canceled' (no ledger row)
 *   everything else             — 200 {received:true}
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

      // Upsert billing_customers row.
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

      // Grant initial subscription credits (idempotent — stripeRef = event.id).
      await grantSubscriptionCredits(database, userId, event.id);

      return { status: 200, body: { received: true } };
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeCustomerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

      if (!stripeCustomerId) {
        alertFounder('billing', { eventType: event.type, note: 'missing_customer' });
        return { status: 200, body: { received: true } };
      }

      // Resolve user from stripeCustomerId.
      const [customer] = await database
        .select({ userId: s.billingCustomers.userId })
        .from(s.billingCustomers)
        .where(eq(s.billingCustomers.stripeCustomerId, stripeCustomerId))
        .limit(1);

      if (!customer) {
        // Unknown customer — alert the founder and ack.
        alertFounder('billing', { eventType: event.type });
        return { status: 200, body: { received: true } };
      }

      // Grant renewal credits (idempotent — stripeRef = event.id).
      await grantSubscriptionCredits(database, customer.userId, event.id);

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

    const result = await handleStripeEvent(database, event);
    return NextResponse.json(result.body, { status: result.status });
  };
}

// ── Production export ─────────────────────────────────────────────────────────

export const POST = createPostHandler(db);
