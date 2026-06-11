/**
 * POST /api/billing/portal
 *
 * Creates a Stripe Billing Portal session for the authenticated user.
 * Looks up stripeCustomerId in billing_customers; returns 404 if none found
 * (i.e. user has never completed a checkout).
 * Returns 503 when STRIPE_SECRET_KEY is unset.
 */

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getStripe } from '@/lib/stripe';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.json({ error: 'BillingUnavailable' }, { status: 503 });
  }

  const [customer] = await db
    .select({ stripeCustomerId: s.billingCustomers.stripeCustomerId })
    .from(s.billingCustomers)
    .where(eq(s.billingCustomers.userId, session.user.id))
    .limit(1);

  if (!customer) {
    return NextResponse.json({ error: 'no_subscription' }, { status: 404 });
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: customer.stripeCustomerId,
    return_url: `${APP_URL}/billing`,
  });

  return NextResponse.json({ url: portalSession.url });
}
