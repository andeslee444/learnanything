/**
 * POST /api/billing/checkout
 *
 * Creates a Stripe Checkout Session for the monthly subscription.
 * Auth: session only (no learner profile required — root of the session ladder).
 * Returns 503 + BillingUnavailable shape when STRIPE_SECRET_KEY is unset.
 */

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getStripe } from '@/lib/stripe';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

export async function POST() {
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

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: session.user.id,
    success_url: `${APP_URL}/billing?success=1`,
    cancel_url: `${APP_URL}/billing`,
  });

  return NextResponse.json({ url: checkoutSession.url });
}
