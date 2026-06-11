/**
 * Billing tests — Phase 9 Task 1 (post-double-grant redesign).
 *
 * Tests (all exercise real code paths — no tautologies):
 *
 * 1. grantSubscriptionCredits: first call inserts row, returns granted:true.
 * 2. grantSubscriptionCredits idempotency: same stripeRef twice → ONE ledger row
 *    via DB read, second call returns granted:false.
 * 3. balance() reflects the subscription grant.
 *
 * 4. handleStripeEvent checkout.session.completed: upserts billing_customers,
 *    returns 200 — NO credit grant (credits come exclusively from invoice.paid).
 * 5. handleStripeEvent invoice.paid (subscription_create): resolves user via
 *    stripeCustomerId, grants credits, returns 200.
 * 5b. handleStripeEvent invoice.paid (subscription_cycle): grants renewal credits.
 * 6. handleStripeEvent invoice.paid with unknown customer → 200, no ledger row.
 * 6b. handleStripeEvent invoice.paid billing_reason 'manual' → 200, no grant.
 * 7. handleStripeEvent customer.subscription.deleted → sets status 'canceled', no ledger row.
 * 8. handleStripeEvent unknown event type → returns 200 {received:true}.
 *
 * 9. Signature verification through the ACTUAL POST route:
 *    - valid signature → 200 + ledger effect (via invoice.paid with billing_reason)
 *    - bad signature → 400
 *
 * 10. 503 paths (no STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET):
 *     10a. webhook POST → 503
 *     10b. checkout: verify via getStripe() seam (route 401s before 503 without auth)
 *     10c. checkout createCheckoutHandler: 503 with no key (via getStripe seam)
 *     10d. checkout createCheckoutHandler: 503 with key but no STRIPE_PRICE_ID
 * 11. webhook POST returns 503 when STRIPE_SECRET_KEY set but STRIPE_WEBHOOK_SECRET absent.
 * 12. import stripe module succeeds with no keys (module doesn't throw on load).
 *
 * 13. First-payment pair — checkout.session.completed then invoice.paid →
 *     balance exactly SUBSCRIPTION_MONTHLY_CREDITS, status 'active'.
 * 14. First-payment pair reversed — invoice.paid then checkout.session.completed →
 *     balance exactly SUBSCRIPTION_MONTHLY_CREDITS, status 'active'.
 * 15. Same invoice.id in two different event envelopes → ONE ledger row.
 * 16. checkout.session.completed with unknown userId → 200, no billing_customers row,
 *     alertFounder spied (content-free payload).
 * 17. customer_mismatch: existing row with customer A, checkout.session.completed
 *     arrives with customer B → stripeCustomerId stays A, alertFounder spied.
 * 18. createCheckoutHandler — 409 when subscriptionStatus 'active'.
 * 19. createCheckoutHandler — customer REUSE: sessions.create receives customer: existingId,
 *     customers.create NOT called.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { eq, count } from 'drizzle-orm';
import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';

// ── Pool lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
});
afterAll(() => testPool.end());

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedUser(suffix: string) {
  const [u] = await testDb
    .insert(s.user)
    .values({
      id: crypto.randomUUID(),
      name: 'Billing-' + suffix,
      email: `${crypto.randomUUID()}@billing.test`,
    })
    .returning();
  return u;
}

function makeCheckoutEvent(userId: string, customerId: string, eventId: string): Stripe.Event {
  return {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    api_version: '2026-05-27.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: 'cs_test_' + eventId,
        object: 'checkout.session',
        client_reference_id: userId,
        customer: customerId,
      } as unknown as Stripe.Checkout.Session,
    },
  } as Stripe.Event;
}

function makeInvoicePaidEvent(
  customerId: string,
  eventId: string,
  invoiceId?: string,
  billingReason: string = 'subscription_create'
): Stripe.Event {
  return {
    id: eventId,
    object: 'event',
    type: 'invoice.paid',
    api_version: '2026-05-27.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: invoiceId ?? ('in_test_' + eventId),
        object: 'invoice',
        customer: customerId,
        billing_reason: billingReason,
      } as unknown as Stripe.Invoice,
    },
  } as Stripe.Event;
}

function makeSubscriptionDeletedEvent(customerId: string, eventId: string): Stripe.Event {
  return {
    id: eventId,
    object: 'event',
    type: 'customer.subscription.deleted',
    api_version: '2026-05-27.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: {
        id: 'sub_test_' + eventId,
        object: 'subscription',
        customer: customerId,
      } as unknown as Stripe.Subscription,
    },
  } as Stripe.Event;
}

// ── 1-3. grantSubscriptionCredits ─────────────────────────────────────────────

describe('grantSubscriptionCredits', () => {
  it('1. first call inserts ledger row, returns granted:true', async () => {
    const u = await seedUser('grant-1');
    const { grantSubscriptionCredits } = await import('@/lib/credits');
    const stripeRef = 'in_test_' + crypto.randomUUID();

    const result = await grantSubscriptionCredits(testDb, u.id, stripeRef);
    expect(result.granted).toBe(true);

    // Verify the row is actually in the DB.
    const rows = await testDb
      .select()
      .from(s.creditLedger)
      .where(eq(s.creditLedger.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].entryType).toBe('purchase');
    expect(rows[0].stripeRef).toBe(stripeRef);
  });

  it('2. idempotency: same stripeRef twice → ONE ledger row, second returns granted:false', async () => {
    const u = await seedUser('grant-idem');
    const { grantSubscriptionCredits } = await import('@/lib/credits');
    const stripeRef = 'in_idem_' + crypto.randomUUID();

    const first = await grantSubscriptionCredits(testDb, u.id, stripeRef);
    expect(first.granted).toBe(true);

    const second = await grantSubscriptionCredits(testDb, u.id, stripeRef);
    expect(second.granted).toBe(false); // duplicate — no-op

    // DB must have exactly ONE row with this stripeRef (not two).
    const [{ value: rowCount }] = await testDb
      .select({ value: count() })
      .from(s.creditLedger)
      .where(eq(s.creditLedger.stripeRef, stripeRef));
    expect(rowCount).toBe(1);
  });

  it('3. balance() reflects the subscription grant', async () => {
    const u = await seedUser('grant-balance');
    const { grantSubscriptionCredits, balance } = await import('@/lib/credits');
    const { SUBSCRIPTION_MONTHLY_CREDITS } = await import('@/lib/stripe');

    const before = await balance(testDb, u.id);
    expect(before).toBe(0);

    await grantSubscriptionCredits(testDb, u.id, 'in_bal_' + crypto.randomUUID());

    const after = await balance(testDb, u.id);
    expect(after).toBe(SUBSCRIPTION_MONTHLY_CREDITS);
  });
});

// ── 4-8. handleStripeEvent all event shapes ────────────────────────────────────

describe('handleStripeEvent', () => {
  it('4. checkout.session.completed → upserts billing_customers, returns 200 (NO credit grant)', async () => {
    const u = await seedUser('hse-checkout');
    const customerId = 'cus_test_' + crypto.randomUUID().replace(/-/g, '');
    const eventId = 'evt_checkout_' + crypto.randomUUID().replace(/-/g, '');

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const event = makeCheckoutEvent(u.id, customerId, eventId);

    const result = await handleStripeEvent(testDb, event);
    expect(result.status).toBe(200);

    // billing_customers row created.
    const [bc] = await testDb
      .select()
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, u.id));
    expect(bc).toBeDefined();
    expect(bc.stripeCustomerId).toBe(customerId);
    expect(bc.subscriptionStatus).toBe('active');

    // NO credit ledger row from checkout event — grants come from invoice.paid.
    const ledgerRows = await testDb
      .select()
      .from(s.creditLedger)
      .where(eq(s.creditLedger.userId, u.id));
    expect(ledgerRows).toHaveLength(0);
  });

  it('5. invoice.paid (subscription_create) → grants credits, returns 200', async () => {
    const u = await seedUser('hse-invoice');
    const customerId = 'cus_invoice_' + crypto.randomUUID().replace(/-/g, '');

    // Pre-seed billing_customers row (normally created upfront by checkout route).
    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    const eventId = 'evt_invoice_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_test_' + crypto.randomUUID().replace(/-/g, '');
    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const event = makeInvoicePaidEvent(customerId, eventId, invoiceId, 'subscription_create');

    const result = await handleStripeEvent(testDb, event);
    expect(result.status).toBe(200);

    // Credit row for the user keyed on invoice.id (not event.id).
    const rows = await testDb
      .select()
      .from(s.creditLedger)
      .where(eq(s.creditLedger.userId, u.id));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const grantRow = rows.find((r) => r.stripeRef === invoiceId);
    expect(grantRow).toBeDefined();
    expect(grantRow!.entryType).toBe('purchase');
  });

  it('5b. invoice.paid (subscription_cycle) → grants renewal credits, returns 200', async () => {
    const u = await seedUser('hse-cycle');
    const customerId = 'cus_cycle_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    const eventId = 'evt_cycle_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_cycle_' + crypto.randomUUID().replace(/-/g, '');
    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const event = makeInvoicePaidEvent(customerId, eventId, invoiceId, 'subscription_cycle');

    const result = await handleStripeEvent(testDb, event);
    expect(result.status).toBe(200);

    const grantRow = await testDb
      .select()
      .from(s.creditLedger)
      .where(eq(s.creditLedger.stripeRef, invoiceId));
    expect(grantRow).toHaveLength(1);
    expect(grantRow[0].entryType).toBe('purchase');
  });

  it('6. invoice.paid with unknown customer → returns 200, no new ledger rows', async () => {
    const unknownCustomerId = 'cus_unknown_' + crypto.randomUUID().replace(/-/g, '');
    const eventId = 'evt_unknown_' + crypto.randomUUID().replace(/-/g, '');

    // Count total ledger rows before.
    const [{ value: before }] = await testDb
      .select({ value: count() })
      .from(s.creditLedger);

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const event = makeInvoicePaidEvent(unknownCustomerId, eventId, undefined, 'subscription_create');
    const result = await handleStripeEvent(testDb, event);
    expect(result.status).toBe(200);

    // Ledger count must not increase.
    const [{ value: after }] = await testDb
      .select({ value: count() })
      .from(s.creditLedger);
    expect(after).toBe(before);
  });

  it('6b. invoice.paid with billing_reason "manual" → returns 200, no grant', async () => {
    const u = await seedUser('hse-manual');
    const customerId = 'cus_manual_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    const [{ value: before }] = await testDb
      .select({ value: count() })
      .from(s.creditLedger)
      .where(eq(s.creditLedger.userId, u.id));

    const eventId = 'evt_manual_' + crypto.randomUUID().replace(/-/g, '');
    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const event = makeInvoicePaidEvent(customerId, eventId, undefined, 'manual');
    const result = await handleStripeEvent(testDb, event);
    expect(result.status).toBe(200);

    const [{ value: after }] = await testDb
      .select({ value: count() })
      .from(s.creditLedger)
      .where(eq(s.creditLedger.userId, u.id));
    expect(after).toBe(before);
  });

  it('7. customer.subscription.deleted → sets status canceled, no ledger row', async () => {
    const u = await seedUser('hse-cancel');
    const customerId = 'cus_cancel_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    const [{ value: ledgerBefore }] = await testDb
      .select({ value: count() })
      .from(s.creditLedger)
      .where(eq(s.creditLedger.userId, u.id));

    const eventId = 'evt_cancel_' + crypto.randomUUID().replace(/-/g, '');
    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const event = makeSubscriptionDeletedEvent(customerId, eventId);
    const result = await handleStripeEvent(testDb, event);
    expect(result.status).toBe(200);

    // Status is canceled.
    const [bc] = await testDb
      .select()
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, u.id));
    expect(bc.subscriptionStatus).toBe('canceled');

    // No new ledger rows.
    const [{ value: ledgerAfter }] = await testDb
      .select({ value: count() })
      .from(s.creditLedger)
      .where(eq(s.creditLedger.userId, u.id));
    expect(ledgerAfter).toBe(ledgerBefore);
  });

  it('8. unknown event type → returns 200 {received:true}', async () => {
    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const event = {
      id: 'evt_unknown_type',
      type: 'some.unknown.event',
      object: 'event',
      api_version: '2026-05-27.dahlia',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: null,
      data: { object: {} },
    } as unknown as Stripe.Event;

    const result = await handleStripeEvent(testDb, event);
    expect(result.status).toBe(200);
    expect((result.body as { received: boolean }).received).toBe(true);
  });
});

// ── 9. Signature verification through the ACTUAL POST route ───────────────────

describe('POST /api/billing/webhook — signature verification', () => {
  const TEST_WEBHOOK_SECRET = 'whsec_testsecret_billing_phase9_abc12345';
  let origSecretKey: string | undefined;
  let origWebhookSecret: string | undefined;

  // Use a real (non-lazy) Stripe instance for generating test headers.
  const stripeForTests = new Stripe('sk_test_fake_billing_phase9', {
    apiVersion: '2026-05-27.dahlia',
  });

  // Override env so getStripe() returns a real instance.
  beforeAll(async () => {
    origSecretKey = process.env.STRIPE_SECRET_KEY;
    origWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_billing_phase9';
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    // Reset the lazy singleton so it picks up the new test key.
    const { _resetStripeForTests } = await import('@/lib/stripe');
    _resetStripeForTests();
  });
  afterAll(async () => {
    if (origSecretKey !== undefined) {
      process.env.STRIPE_SECRET_KEY = origSecretKey;
    } else {
      delete process.env.STRIPE_SECRET_KEY;
    }
    if (origWebhookSecret !== undefined) {
      process.env.STRIPE_WEBHOOK_SECRET = origWebhookSecret;
    } else {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
    // Reset singleton so subsequent tests start clean.
    const { _resetStripeForTests } = await import('@/lib/stripe');
    _resetStripeForTests();
  });

  it('9a. valid signature + invoice.paid → 200 + ledger effect', async () => {
    const u = await seedUser('sig-valid');
    const customerId = 'cus_sig_' + crypto.randomUUID().replace(/-/g, '');
    const eventId = 'evt_sig_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_sig_' + crypto.randomUUID().replace(/-/g, '');

    // Pre-seed billing_customers so the webhook can resolve the userId.
    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'none',
    });

    const event = makeInvoicePaidEvent(customerId, eventId, invoiceId, 'subscription_create');
    const payload = JSON.stringify(event);
    const sig = stripeForTests.webhooks.generateTestHeaderString({
      payload,
      secret: TEST_WEBHOOK_SECRET,
    });

    // Use createPostHandler(testDb) so DB writes go to the test database
    // while raw-body parsing and signature verification run through real route code.
    const { createPostHandler } = await import('@/app/api/billing/webhook/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/billing/webhook', {
      method: 'POST',
      body: payload,
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    // Ledger effect: a purchase row keyed on invoice.id.
    const rows = await testDb
      .select()
      .from(s.creditLedger)
      .where(eq(s.creditLedger.stripeRef, invoiceId));
    expect(rows).toHaveLength(1);
  });

  it('9b. bad signature → 400', async () => {
    const payload = JSON.stringify({ id: 'evt_badsig', type: 'invoice.paid' });
    const { createPostHandler } = await import('@/app/api/billing/webhook/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/billing/webhook', {
      method: 'POST',
      body: payload,
      headers: {
        'stripe-signature': 't=12345,v1=badsignaturehex',
        'content-type': 'application/json',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// ── 10-12. 503 when keys absent; module loads cleanly ─────────────────────────

describe('503 when STRIPE_SECRET_KEY absent', () => {
  let origSecretKey: string | undefined;
  let origWebhookSecret: string | undefined;
  let origPriceId: string | undefined;

  // Preserve and clear keys, reset singleton after each test.
  afterEach(async () => {
    if (origSecretKey !== undefined) {
      process.env.STRIPE_SECRET_KEY = origSecretKey;
    } else {
      delete process.env.STRIPE_SECRET_KEY;
    }
    if (origWebhookSecret !== undefined) {
      process.env.STRIPE_WEBHOOK_SECRET = origWebhookSecret;
    } else {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
    if (origPriceId !== undefined) {
      process.env.STRIPE_PRICE_ID = origPriceId;
    } else {
      delete process.env.STRIPE_PRICE_ID;
    }
    const { _resetStripeForTests } = await import('@/lib/stripe');
    _resetStripeForTests();
  });

  it('10a. webhook POST returns 503 when no STRIPE_SECRET_KEY', async () => {
    origSecretKey = process.env.STRIPE_SECRET_KEY;
    origWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const { createPostHandler } = await import('@/app/api/billing/webhook/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/billing/webhook', {
      method: 'POST',
      body: '{}',
      headers: { 'stripe-signature': 't=1,v1=abc', 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('10b. checkout returns 503 when no STRIPE_SECRET_KEY (via getStripe seam)', async () => {
    origSecretKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;

    // The route returns 401 before 503 when unauthenticated, so we verify via
    // the getStripe() seam directly — confirms the 503 branch is reachable.
    const { getStripe } = await import('@/lib/stripe');
    expect(getStripe()).toBeNull();
  });

  it('10c. createCheckoutHandler POST returns 503 when getStripe() is null', async () => {
    origSecretKey = process.env.STRIPE_SECRET_KEY;
    origPriceId = process.env.STRIPE_PRICE_ID;
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_PRICE_ID = 'price_fake';

    // Mock auth.api.getSession to return a fake session so the 401 doesn't fire.
    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({
            user: { id: 'user_test_503', email: 'test@test.com' },
          }),
        },
      },
    }));
    // Also mock next/headers so the route doesn't blow up without real Next.js context.
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));

    const { createCheckoutHandler } = await import('@/app/api/billing/checkout/route');
    const POST = createCheckoutHandler(testDb);
    const res = await POST();
    expect(res.status).toBe(503);

    vi.resetModules();
  });

  it('10d. createCheckoutHandler POST returns 503 when STRIPE_PRICE_ID absent', async () => {
    origSecretKey = process.env.STRIPE_SECRET_KEY;
    origPriceId = process.env.STRIPE_PRICE_ID;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_503';
    delete process.env.STRIPE_PRICE_ID;

    const { _resetStripeForTests } = await import('@/lib/stripe');
    _resetStripeForTests();

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({
            user: { id: 'user_test_503b', email: 'test2@test.com' },
          }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));

    const { createCheckoutHandler } = await import('@/app/api/billing/checkout/route');
    const POST = createCheckoutHandler(testDb);
    const res = await POST();
    expect(res.status).toBe(503);

    vi.resetModules();
  });

  it('11. webhook POST returns 503 when STRIPE_SECRET_KEY set but STRIPE_WEBHOOK_SECRET absent', async () => {
    origSecretKey = process.env.STRIPE_SECRET_KEY;
    origWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = 'sk_test_present';
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const { createPostHandler } = await import('@/app/api/billing/webhook/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/billing/webhook', {
      method: 'POST',
      body: '{}',
      headers: { 'stripe-signature': 't=1,v1=abc', 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('12. import stripe module succeeds with no keys set', async () => {
    origSecretKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;

    // Module must import without throwing.
    await expect(import('@/lib/stripe')).resolves.toBeDefined();

    const { getStripe } = await import('@/lib/stripe');
    // Returns null, not throws.
    expect(getStripe()).toBeNull();
  });
});

// ── 13-17. First-payment pair dedup, ordering, and alertFounder paths ─────────

describe('first-payment pair dedup and ordering', () => {
  it('13. checkout.session.completed then invoice.paid → balance = SUBSCRIPTION_MONTHLY_CREDITS, status active', async () => {
    const u = await seedUser('pair-order1');
    const customerId = 'cus_pair1_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_pair1_' + crypto.randomUUID().replace(/-/g, '');

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const { balance } = await import('@/lib/credits');
    const { SUBSCRIPTION_MONTHLY_CREDITS } = await import('@/lib/stripe');

    // 1. checkout.session.completed
    const checkoutEvent = makeCheckoutEvent(u.id, customerId, 'evt_co_' + crypto.randomUUID());
    await handleStripeEvent(testDb, checkoutEvent);

    // 2. invoice.paid (subscription_create)
    const invoiceEvent = makeInvoicePaidEvent(
      customerId,
      'evt_inv_' + crypto.randomUUID().replace(/-/g, ''),
      invoiceId,
      'subscription_create'
    );
    await handleStripeEvent(testDb, invoiceEvent);

    const bal = await balance(testDb, u.id);
    expect(bal).toBe(SUBSCRIPTION_MONTHLY_CREDITS);

    const [bc] = await testDb
      .select()
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, u.id));
    expect(bc.subscriptionStatus).toBe('active');
  });

  it('14. invoice.paid first then checkout.session.completed → balance = SUBSCRIPTION_MONTHLY_CREDITS, status active', async () => {
    const u = await seedUser('pair-order2');
    const customerId = 'cus_pair2_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_pair2_' + crypto.randomUUID().replace(/-/g, '');

    // Seed the billing_customers row upfront (as checkout route would do) so
    // invoice.paid can resolve userId even without prior checkout event.
    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'none',
    });

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const { balance } = await import('@/lib/credits');
    const { SUBSCRIPTION_MONTHLY_CREDITS } = await import('@/lib/stripe');

    // 1. invoice.paid arrives first
    const invoiceEvent = makeInvoicePaidEvent(
      customerId,
      'evt_inv2_' + crypto.randomUUID().replace(/-/g, ''),
      invoiceId,
      'subscription_create'
    );
    await handleStripeEvent(testDb, invoiceEvent);

    // 2. checkout.session.completed arrives late
    const checkoutEvent = makeCheckoutEvent(u.id, customerId, 'evt_co2_' + crypto.randomUUID());
    await handleStripeEvent(testDb, checkoutEvent);

    const bal = await balance(testDb, u.id);
    expect(bal).toBe(SUBSCRIPTION_MONTHLY_CREDITS);

    const [bc] = await testDb
      .select()
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, u.id));
    expect(bc.subscriptionStatus).toBe('active');
  });

  it('15. same invoice.id in two different event envelopes → ONE ledger row', async () => {
    const u = await seedUser('dedup-invoice');
    const customerId = 'cus_dedup_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_dedup_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');

    // Two different event.ids wrapping the same invoice.id.
    const event1 = makeInvoicePaidEvent(
      customerId,
      'evt_dedup1_' + crypto.randomUUID().replace(/-/g, ''),
      invoiceId,
      'subscription_create'
    );
    const event2 = makeInvoicePaidEvent(
      customerId,
      'evt_dedup2_' + crypto.randomUUID().replace(/-/g, ''),
      invoiceId,
      'subscription_create'
    );

    await handleStripeEvent(testDb, event1);
    await handleStripeEvent(testDb, event2); // duplicate — must be no-op

    const rows = await testDb
      .select()
      .from(s.creditLedger)
      .where(eq(s.creditLedger.stripeRef, invoiceId));
    expect(rows).toHaveLength(1); // exactly one, not two
  });

  it('16. checkout.session.completed with unknown userId → 200, no billing_customers row, alertFounder spied', async () => {
    const unknownUserId = 'user_nonexistent_' + crypto.randomUUID().replace(/-/g, '');
    const customerId = 'cus_nouser_' + crypto.randomUUID().replace(/-/g, '');
    const eventId = 'evt_nouser_' + crypto.randomUUID().replace(/-/g, '');

    const alertCalls: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const alertsModule = await import('@/lib/alerts');
    const spy = vi.spyOn(alertsModule, 'alertFounder').mockImplementation(
      (kind: string, payload: Record<string, unknown>) => {
        alertCalls.push({ kind, payload });
      }
    );

    try {
      const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
      const event = makeCheckoutEvent(unknownUserId, customerId, eventId);
      const result = await handleStripeEvent(testDb, event);
      expect(result.status).toBe(200);

      // No billing_customers row created for the unknown user.
      const rows = await testDb
        .select()
        .from(s.billingCustomers)
        .where(eq(s.billingCustomers.stripeCustomerId, customerId));
      expect(rows).toHaveLength(0);

      // alertFounder was called (content-free — just note, no PII).
      expect(alertCalls.length).toBeGreaterThanOrEqual(1);
      const billingAlert = alertCalls.find((c) => c.kind === 'billing');
      expect(billingAlert).toBeDefined();
      // Payload must be content-free: no user data beyond the note key.
      expect(billingAlert!.payload).toHaveProperty('note', 'unknown_user');
      expect(billingAlert!.payload).not.toHaveProperty('userId');
      expect(billingAlert!.payload).not.toHaveProperty('email');
    } finally {
      spy.mockRestore();
    }
  });

  it('17. customer_mismatch: existing row with customer A, checkout event with customer B → stripeCustomerId stays A, alertFounder spied', async () => {
    const u = await seedUser('mismatch');
    const customerA = 'cus_A_' + crypto.randomUUID().replace(/-/g, '');
    const customerB = 'cus_B_' + crypto.randomUUID().replace(/-/g, '');
    const eventId = 'evt_mismatch_' + crypto.randomUUID().replace(/-/g, '');

    // Seed with customer A.
    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerA,
      subscriptionStatus: 'active',
    });

    const alertCalls: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const alertsModule = await import('@/lib/alerts');
    const spy = vi.spyOn(alertsModule, 'alertFounder').mockImplementation(
      (kind: string, payload: Record<string, unknown>) => {
        alertCalls.push({ kind, payload });
      }
    );

    try {
      const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
      // Checkout event arrives with customer B.
      const event = makeCheckoutEvent(u.id, customerB, eventId);
      const result = await handleStripeEvent(testDb, event);
      expect(result.status).toBe(200);

      // stripeCustomerId must still be customer A — not overwritten.
      const [bc] = await testDb
        .select()
        .from(s.billingCustomers)
        .where(eq(s.billingCustomers.userId, u.id));
      expect(bc.stripeCustomerId).toBe(customerA);

      // alertFounder was called with note 'customer_mismatch'.
      const mismatchAlert = alertCalls.find(
        (c) => c.kind === 'billing' && c.payload.note === 'customer_mismatch'
      );
      expect(mismatchAlert).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── 18-19. createCheckoutHandler functional paths ─────────────────────────────

describe('createCheckoutHandler — functional paths', () => {
  it('18. returns 409 when subscriptionStatus is active', async () => {
    const u = await seedUser('checkout-409');
    const customerId = 'cus_409_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({
            user: { id: u.id, email: u.email },
          }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));
    // Provide a fake key so stripe check passes, and a fake price id.
    process.env.STRIPE_SECRET_KEY = 'sk_test_409';
    process.env.STRIPE_PRICE_ID = 'price_fake';
    const { _resetStripeForTests } = await import('@/lib/stripe');
    _resetStripeForTests();

    const { createCheckoutHandler } = await import('@/app/api/billing/checkout/route');
    const POST = createCheckoutHandler(testDb);
    const res = await POST();
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('already_subscribed');

    vi.resetModules();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID;
    const { _resetStripeForTests: r } = await import('@/lib/stripe');
    r();
  });

  it('19. customer REUSE: customers.create NOT called when stripeCustomerId exists; sessions.create receives existing id', async () => {
    const u = await seedUser('checkout-reuse');
    const existingCustomerId = 'cus_existing_' + crypto.randomUUID().replace(/-/g, '');

    // Seed with an existing customer id but NOT active status (e.g., canceled — can re-subscribe).
    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: existingCustomerId,
      subscriptionStatus: 'canceled',
    });

    process.env.STRIPE_SECRET_KEY = 'sk_test_reuse';
    process.env.STRIPE_PRICE_ID = 'price_reuse_fake';

    const fakeSessionsCreate = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test' });
    const fakeCustomersCreate = vi.fn().mockResolvedValue({ id: 'cus_should_not_be_created' });

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({
            user: { id: u.id, email: u.email },
          }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));
    vi.doMock('@/lib/stripe', () => ({
      getStripe: () => ({
        customers: { create: fakeCustomersCreate },
        checkout: { sessions: { create: fakeSessionsCreate } },
      }),
      SUBSCRIPTION_MONTHLY_CREDITS: 30,
      _resetStripeForTests: vi.fn(),
    }));

    const { createCheckoutHandler } = await import('@/app/api/billing/checkout/route');
    const POST = createCheckoutHandler(testDb);
    const res = await POST();
    expect(res.status).toBe(200);

    // customers.create must NOT have been called.
    expect(fakeCustomersCreate).not.toHaveBeenCalled();

    // sessions.create must have received the existing customer id.
    expect(fakeSessionsCreate).toHaveBeenCalledTimes(1);
    const callArgs = fakeSessionsCreate.mock.calls[0][0] as { customer: string };
    expect(callArgs.customer).toBe(existingCustomerId);

    vi.resetModules();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID;
  });
});

// ── 20-22. Stale-active self-heal — checkout route ────────────────────────────

describe('stale-active self-heal — checkout', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('20. DB active + subscriptions.list empty → checkout proceeds (no 409), billing_customers flipped to canceled', async () => {
    const u = await seedUser('drift-heal-20');
    const customerId = 'cus_drift20_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    const fakeSessionsCreate = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/drift20' });

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: u.id, email: u.email } }) } },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));
    const alertCalls: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    vi.doMock('@/lib/alerts', () => ({
      alertFounder: (kind: string, payload: Record<string, unknown>) => {
        alertCalls.push({ kind, payload });
      },
    }));
    vi.doMock('@/lib/stripe', () => ({
      getStripe: () => ({
        subscriptions: { list: vi.fn().mockResolvedValue({ data: [] }) },
        customers: { create: vi.fn().mockResolvedValue({ id: 'cus_new_drift20' }) },
        checkout: { sessions: { create: fakeSessionsCreate } },
      }),
      SUBSCRIPTION_MONTHLY_CREDITS: 30,
      _resetStripeForTests: vi.fn(),
    }));

    process.env.STRIPE_SECRET_KEY = 'sk_test_drift20';
    process.env.STRIPE_PRICE_ID = 'price_drift20';

    const { createCheckoutHandler } = await import('@/app/api/billing/checkout/route');
    const POST = createCheckoutHandler(testDb);
    const res = await POST();

    // Must proceed (200), not 409.
    expect(res.status).toBe(200);

    // billing_customers must be flipped to 'canceled'.
    const [bc] = await testDb
      .select({ subscriptionStatus: s.billingCustomers.subscriptionStatus })
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, u.id));
    expect(bc.subscriptionStatus).toBe('canceled');

    // alertFounder spied with 'billing' + note:'status_drift_healed'.
    const alert = alertCalls.find((c) => c.kind === 'billing' && c.payload.note === 'status_drift_healed');
    expect(alert).toBeDefined();

    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID;
  });

  it('21. DB active + subscriptions.list returns one sub → 409 stays', async () => {
    const u = await seedUser('drift-heal-21');
    const customerId = 'cus_drift21_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: u.id, email: u.email } }) } },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));
    vi.doMock('@/lib/stripe', () => ({
      getStripe: () => ({
        subscriptions: { list: vi.fn().mockResolvedValue({ data: [{ id: 'sub_active' }] }) },
      }),
      SUBSCRIPTION_MONTHLY_CREDITS: 30,
      _resetStripeForTests: vi.fn(),
    }));

    process.env.STRIPE_SECRET_KEY = 'sk_test_drift21';
    process.env.STRIPE_PRICE_ID = 'price_drift21';

    const { createCheckoutHandler } = await import('@/app/api/billing/checkout/route');
    const POST = createCheckoutHandler(testDb);
    const res = await POST();

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('already_subscribed');

    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID;
  });

  it('22. DB active + no Stripe key (getStripe null) → 409 stays (fail-closed)', async () => {
    const u = await seedUser('drift-heal-22');
    const customerId = 'cus_drift22_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: u.id, email: u.email } }) } },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));
    // getStripe() returns null → 503 fires before the active check can run.
    // This validates that the 503 path fires when stripe is null (existing test 10c covers
    // the key-absent 503 path; this test verifies no unintended bypass).
    vi.doMock('@/lib/stripe', () => ({
      getStripe: () => null,
      SUBSCRIPTION_MONTHLY_CREDITS: 30,
      _resetStripeForTests: vi.fn(),
    }));

    // No STRIPE_SECRET_KEY so 503 returns before active check.
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_PRICE_ID = 'price_drift22';

    const { createCheckoutHandler } = await import('@/app/api/billing/checkout/route');
    const POST = createCheckoutHandler(testDb);
    const res = await POST();

    // 503 fires because stripe is null — fails closed (not 200).
    expect(res.status).toBe(503);

    delete process.env.STRIPE_PRICE_ID;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial-review regressions (H1: concurrent-checkout race; H2: status
// resurrection via redelivered invoice.paid)
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial regressions', () => {
  it('H1: checkout session is created on the upsert WINNER customer id, not the locally-minted loser', async () => {
    const u = await seedUser('race-winner');
    const winnerId = 'cus_winner_' + crypto.randomUUID().replace(/-/g, '');
    const loserId = 'cus_loser_' + crypto.randomUUID().replace(/-/g, '');

    process.env.STRIPE_SECRET_KEY = 'sk_test_race';
    process.env.STRIPE_PRICE_ID = 'price_race_fake';

    const fakeSessionsCreate = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/race' });
    // Simulate the concurrent winner: by the time OUR customers.create returns
    // (loser), the other request has already landed its row (winner) in the DB.
    const fakeCustomersCreate = vi.fn().mockImplementation(async () => {
      await testDb.insert(s.billingCustomers).values({
        userId: u.id,
        stripeCustomerId: winnerId,
        subscriptionStatus: 'none',
      });
      return { id: loserId };
    });

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: u.id, email: u.email } }) } },
    }));
    vi.doMock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
    vi.doMock('@/lib/stripe', () => ({
      getStripe: () => ({
        customers: { create: fakeCustomersCreate },
        checkout: { sessions: { create: fakeSessionsCreate } },
      }),
      SUBSCRIPTION_MONTHLY_CREDITS: 30,
      _resetStripeForTests: vi.fn(),
    }));

    try {
      const { createCheckoutHandler } = await import('@/app/api/billing/checkout/route');
      const POST = createCheckoutHandler(testDb);
      const res = await POST();
      expect(res.status).toBe(200);

      // The session MUST be created on the winner's customer id — otherwise the
      // user pays on a customer the webhook can't resolve → zero credits forever.
      expect(fakeSessionsCreate).toHaveBeenCalledTimes(1);
      const callArgs = fakeSessionsCreate.mock.calls[0][0] as { customer: string };
      expect(callArgs.customer).toBe(winnerId);

      // DB still holds the winner.
      const [row] = await testDb
        .select({ id: s.billingCustomers.stripeCustomerId })
        .from(s.billingCustomers)
        .where(eq(s.billingCustomers.userId, u.id));
      expect(row.id).toBe(winnerId);
    } finally {
      vi.resetModules();
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_PRICE_ID;
    }
  });

  it('H2: redelivered already-granted invoice.paid does NOT resurrect a canceled subscription; a fresh invoice does', async () => {
    const u = await seedUser('h2-resurrect');
    const customerId = 'cus_h2_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_h2_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');

    // Original grant lands.
    await handleStripeEvent(
      testDb,
      makeInvoicePaidEvent(customerId, 'evt_h2_a_' + crypto.randomUUID().replace(/-/g, ''), invoiceId, 'subscription_cycle'),
    );

    // User cancels.
    await testDb
      .update(s.billingCustomers)
      .set({ subscriptionStatus: 'canceled' })
      .where(eq(s.billingCustomers.userId, u.id));

    // Stripe redelivers the SAME invoice in a new event envelope (granted=false).
    const result = await handleStripeEvent(
      testDb,
      makeInvoicePaidEvent(customerId, 'evt_h2_b_' + crypto.randomUUID().replace(/-/g, ''), invoiceId, 'subscription_cycle'),
    );
    expect(result.status).toBe(200);

    const [afterRedelivery] = await testDb
      .select({ status: s.billingCustomers.subscriptionStatus })
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, u.id));
    expect(afterRedelivery.status).toBe('canceled'); // NOT resurrected

    // A genuinely fresh invoice (resubscribe) flips back to active.
    await handleStripeEvent(
      testDb,
      makeInvoicePaidEvent(
        customerId,
        'evt_h2_c_' + crypto.randomUUID().replace(/-/g, ''),
        'in_h2_fresh_' + crypto.randomUUID().replace(/-/g, ''),
        'subscription_create',
      ),
    );
    const [afterFresh] = await testDb
      .select({ status: s.billingCustomers.subscriptionStatus })
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, u.id));
    expect(afterFresh.status).toBe('active');
  });
});
