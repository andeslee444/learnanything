/**
 * Stripe seam — Phase 9.
 *
 * getStripe() returns a live Stripe instance when STRIPE_SECRET_KEY is set,
 * or null otherwise. The lazy singleton pattern means this module can always
 * be imported (e.g. in tests) without throwing, even when the key is absent.
 *
 * Pricing philosophy: one lesson = 1 credit; $15/mo ≈ 50¢/lesson at 30 credits.
 * The founder can retune SUBSCRIPTION_MONTHLY_CREDITS without touching the
 * billing flow — just bump the constant and deploy.
 */

import Stripe from 'stripe';

/** Credits granted per subscription renewal. One lesson = 1 credit. */
export const SUBSCRIPTION_MONTHLY_CREDITS = 30;

let _stripe: Stripe | null = null;

/**
 * Returns the shared Stripe instance, or null when STRIPE_SECRET_KEY is unset.
 * Lazy singleton: first call initialises; subsequent calls return the same instance.
 * Never throws — callers must check for null and return a 503 JSON response.
 */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!_stripe) {
    _stripe = new Stripe(key, { apiVersion: '2026-05-27.dahlia' });
  }
  return _stripe;
}

/**
 * Reset the lazy singleton — FOR TESTS ONLY.
 * Allows tests that manipulate STRIPE_SECRET_KEY to get a fresh instance.
 */
export function _resetStripeForTests(): void {
  _stripe = null;
}

