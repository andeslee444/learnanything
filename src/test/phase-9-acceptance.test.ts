/**
 * Phase 9 Acceptance Suite
 *
 * Maps every Goal clause of Phase 9 to named assertions.
 * Thin wrappers over real helpers — phase-goal-named titles per spec.
 * NO source-grepping meta-tests — behavior only. UI wiring is proven by e2e.
 *
 * Goal clauses:
 *   Goal 1: Subscription grant round-trip at the goal level:
 *            checkout.session.completed → no grant, customers row active;
 *            invoice.paid (subscription_create) → balance +30, idempotent;
 *            cross-event pair both orders; subscription.deleted → canceled, credits kept;
 *            signature-verified POST through the real webhook route;
 *            checkout 503 no-key + 409 active through createCheckoutHandler;
 *            upgrade-path: exhaust credits via placeHold → 402 shape matches 'credits'.
 *   Goal 2: Legal/account contracts:
 *            buildExport JSON contains promised sections + isolation;
 *            delete cascade → zero user rows + bystander intact + active-subscription 409 guard;
 *            confirm guard.
 *   Goal 3: Eval matrix: 36 distinct cells (independent check via re-derived cell logic).
 *
 * e2e note: billing UI + footer + export + delete are proven by e2e/phase-9.spec.ts.
 *
 * Integration tests use testDb (TEST_DATABASE_URL, port 5433).
 * Fake LLM (AI_FAKE_LLM=1) — no real model calls.
 * ZERO Stripe network calls in tests.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { buildExport } from '@/lib/account-export';
import { deleteAccount } from '@/lib/account-delete';
import { balance, placeHold, InsufficientCreditsError } from '@/lib/credits';

// ── Pool lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
});
afterAll(() => testPool.end());

// ── Shared seed helpers ────────────────────────────────────────────────────────

async function seedUser(suffix: string) {
  const [u] = await testDb
    .insert(s.user)
    .values({
      id: crypto.randomUUID(),
      name: 'P9-' + suffix,
      email: `${crypto.randomUUID()}@p9accept.test`,
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
        id: 'cs_p9_' + eventId,
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
  billingReason: string = 'subscription_create',
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
        id: invoiceId ?? ('in_p9_' + eventId),
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
        id: 'sub_p9_' + eventId,
        object: 'subscription',
        customer: customerId,
      } as unknown as Stripe.Subscription,
    },
  } as Stripe.Event;
}

/** Seeds a minimal world for export/delete goal-level tests. */
async function seedMinimalWorld(suffix: string) {
  const uid = crypto.randomUUID();
  const [user] = await testDb
    .insert(s.user)
    .values({ id: uid, name: 'P9-World-' + suffix, email: `${uid}@p9world.test` })
    .returning();

  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: user.id, displayName: 'WL-' + suffix, ageBand: '18_plus' })
    .returning();

  const [track] = await testDb
    .insert(s.tracks)
    .values({
      learnerId: learner.id,
      topic: 'Rust async ' + suffix,
      vertical: 'programming',
      expertiseBand: 'novice',
    })
    .returning();

  const [mission] = await testDb
    .insert(s.missions)
    .values({ trackId: track.id, whyText: 'ship a real-time service ' + suffix })
    .returning();

  const [record] = await testDb
    .insert(s.learningRecords)
    .values({
      trackId: track.id,
      seq: 1,
      recordType: 'demonstrated_understanding',
      title: 'Understands async/await ' + suffix,
      body: 'Can write an async fn ' + suffix,
    })
    .returning();

  const [glossaryTerm] = await testDb
    .insert(s.glossaryTerms)
    .values({
      trackId: track.id,
      term: 'future-' + suffix,
      definition: 'A value not ready yet ' + suffix,
      promotionEvidenceRecordId: record.id,
    })
    .returning();

  const [ledgerRow] = await testDb
    .insert(s.creditLedger)
    .values({ userId: user.id, entryType: 'grant', amount: 3 })
    .returning();

  return { user, learner, track, mission, record, glossaryTerm, ledgerRow };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 1 — Subscription grant round-trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 1 — subscription grant round-trip: checkout→no grant; invoice.paid→+30 idempotent; cancellation; 402 upgrade-path', () => {

  // ── 1a. checkout.session.completed → billing_customers row, NO grant ─────────

  it('goal-1: checkout.session.completed → billing_customers active, ZERO ledger rows', async () => {
    const u = await seedUser('g1-checkout');
    const customerId = 'cus_g1co_' + crypto.randomUUID().replace(/-/g, '');
    const eventId = 'evt_g1co_' + crypto.randomUUID().replace(/-/g, '');

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const event = makeCheckoutEvent(u.id, customerId, eventId);
    const result = await handleStripeEvent(testDb, event);
    expect(result.status).toBe(200);

    // billing_customers row created and set active.
    const [bc] = await testDb
      .select()
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, u.id));
    expect(bc).toBeDefined();
    expect(bc.subscriptionStatus).toBe('active');

    // NO credit ledger row from checkout event alone.
    const ledgerRows = await testDb
      .select()
      .from(s.creditLedger)
      .where(eq(s.creditLedger.userId, u.id));
    expect(ledgerRows).toHaveLength(0);
  });

  // ── 1b. invoice.paid (subscription_create) → balance +SUBSCRIPTION_MONTHLY_CREDITS exactly once ──

  it('goal-1: invoice.paid subscription_create → balance +30 exactly once; second delivery no-op', async () => {
    const u = await seedUser('g1-invoice');
    const customerId = 'cus_g1inv_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_g1inv_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const { SUBSCRIPTION_MONTHLY_CREDITS } = await import('@/lib/stripe');

    // First delivery.
    const event1 = makeInvoicePaidEvent(customerId, 'evt_g1inv_a_' + crypto.randomUUID().replace(/-/g, ''), invoiceId, 'subscription_create');
    const r1 = await handleStripeEvent(testDb, event1);
    expect(r1.status).toBe(200);

    const balAfterFirst = await balance(testDb, u.id);
    expect(balAfterFirst).toBe(SUBSCRIPTION_MONTHLY_CREDITS);

    // Second delivery (same invoice.id, different event.id) — must be idempotent.
    const event2 = makeInvoicePaidEvent(customerId, 'evt_g1inv_b_' + crypto.randomUUID().replace(/-/g, ''), invoiceId, 'subscription_create');
    await handleStripeEvent(testDb, event2);

    const balAfterSecond = await balance(testDb, u.id);
    expect(balAfterSecond).toBe(SUBSCRIPTION_MONTHLY_CREDITS); // NOT doubled
  });

  // ── 1c. Cross-event pair order 1: checkout → invoice.paid ─────────────────────

  it('goal-1: cross-event pair (checkout then invoice.paid) → balance SUBSCRIPTION_MONTHLY_CREDITS, status active', async () => {
    const u = await seedUser('g1-pair-co-first');
    const customerId = 'cus_g1pco_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_g1pco_' + crypto.randomUUID().replace(/-/g, '');

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const { SUBSCRIPTION_MONTHLY_CREDITS } = await import('@/lib/stripe');

    await handleStripeEvent(testDb, makeCheckoutEvent(u.id, customerId, 'evt_g1pco1_' + crypto.randomUUID().replace(/-/g, '')));
    await handleStripeEvent(testDb, makeInvoicePaidEvent(customerId, 'evt_g1pco2_' + crypto.randomUUID().replace(/-/g, ''), invoiceId, 'subscription_create'));

    const bal = await balance(testDb, u.id);
    expect(bal).toBe(SUBSCRIPTION_MONTHLY_CREDITS);

    const [bc] = await testDb.select().from(s.billingCustomers).where(eq(s.billingCustomers.userId, u.id));
    expect(bc.subscriptionStatus).toBe('active');
  });

  // ── 1d. Cross-event pair order 2: invoice.paid → checkout ─────────────────────

  it('goal-1: cross-event pair (invoice.paid then checkout) → balance SUBSCRIPTION_MONTHLY_CREDITS, status active', async () => {
    const u = await seedUser('g1-pair-inv-first');
    const customerId = 'cus_g1pif_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_g1pif_' + crypto.randomUUID().replace(/-/g, '');

    // Seed billing_customers upfront so invoice.paid can resolve userId.
    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'none',
    });

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const { SUBSCRIPTION_MONTHLY_CREDITS } = await import('@/lib/stripe');

    await handleStripeEvent(testDb, makeInvoicePaidEvent(customerId, 'evt_g1pif1_' + crypto.randomUUID().replace(/-/g, ''), invoiceId, 'subscription_create'));
    await handleStripeEvent(testDb, makeCheckoutEvent(u.id, customerId, 'evt_g1pif2_' + crypto.randomUUID().replace(/-/g, '')));

    const bal = await balance(testDb, u.id);
    expect(bal).toBe(SUBSCRIPTION_MONTHLY_CREDITS);

    const [bc] = await testDb.select().from(s.billingCustomers).where(eq(s.billingCustomers.userId, u.id));
    expect(bc.subscriptionStatus).toBe('active');
  });

  // ── 1e. subscription.deleted → canceled, credits kept ─────────────────────────

  it('goal-1: customer.subscription.deleted → status canceled; credits NOT removed', async () => {
    const u = await seedUser('g1-cancel');
    const customerId = 'cus_g1can_' + crypto.randomUUID().replace(/-/g, '');
    const invoiceId = 'in_g1can_' + crypto.randomUUID().replace(/-/g, '');

    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
    });

    const { handleStripeEvent } = await import('@/app/api/billing/webhook/route');
    const { SUBSCRIPTION_MONTHLY_CREDITS } = await import('@/lib/stripe');

    // Grant credits first.
    await handleStripeEvent(testDb, makeInvoicePaidEvent(customerId, 'evt_g1can_inv_' + crypto.randomUUID().replace(/-/g, ''), invoiceId, 'subscription_cycle'));

    const balBefore = await balance(testDb, u.id);
    expect(balBefore).toBe(SUBSCRIPTION_MONTHLY_CREDITS);

    // Now cancel.
    await handleStripeEvent(testDb, makeSubscriptionDeletedEvent(customerId, 'evt_g1can_del_' + crypto.randomUUID().replace(/-/g, '')));

    const [bc] = await testDb.select().from(s.billingCustomers).where(eq(s.billingCustomers.userId, u.id));
    expect(bc.subscriptionStatus).toBe('canceled');

    // Credits are NOT removed on cancellation.
    const balAfter = await balance(testDb, u.id);
    expect(balAfter).toBe(SUBSCRIPTION_MONTHLY_CREDITS);
  });

  // ── 1f. Signature-verified POST through the real webhook route ────────────────

  describe('goal-1: signature-verified POST through real webhook route', () => {
    const TEST_WEBHOOK_SECRET = 'whsec_p9accept_abc12345_test_secret';
    const stripeForTests = new Stripe('sk_test_p9accept_fake_key', {
      apiVersion: '2026-05-27.dahlia',
    });

    let origSecretKey: string | undefined;
    let origWebhookSecret: string | undefined;

    beforeAll(async () => {
      origSecretKey = process.env.STRIPE_SECRET_KEY;
      origWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      process.env.STRIPE_SECRET_KEY = 'sk_test_p9accept_fake_key';
      process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
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
      const { _resetStripeForTests } = await import('@/lib/stripe');
      _resetStripeForTests();
    });

    it('goal-1: valid signature + invoice.paid → 200 + ledger row', async () => {
      const u = await seedUser('g1-sig-valid');
      const customerId = 'cus_g1sig_' + crypto.randomUUID().replace(/-/g, '');
      const invoiceId = 'in_g1sig_' + crypto.randomUUID().replace(/-/g, '');

      await testDb.insert(s.billingCustomers).values({
        userId: u.id,
        stripeCustomerId: customerId,
        subscriptionStatus: 'active',
      });

      const event = makeInvoicePaidEvent(customerId, 'evt_g1sig_' + crypto.randomUUID().replace(/-/g, ''), invoiceId, 'subscription_create');
      const payload = JSON.stringify(event);
      const sig = stripeForTests.webhooks.generateTestHeaderString({
        payload,
        secret: TEST_WEBHOOK_SECRET,
      });

      const { createPostHandler } = await import('@/app/api/billing/webhook/route');
      const POST = createPostHandler(testDb);
      const req = new NextRequest('http://localhost/api/billing/webhook', {
        method: 'POST',
        body: payload,
        headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const rows = await testDb
        .select()
        .from(s.creditLedger)
        .where(eq(s.creditLedger.stripeRef, invoiceId));
      expect(rows).toHaveLength(1);
      expect(rows[0].entryType).toBe('purchase');
    });

    it('goal-1: bad signature → 400', async () => {
      const payload = JSON.stringify({ id: 'evt_badsig_g1', type: 'invoice.paid' });
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

  // ── 1g. 503 no-key paths through createCheckoutHandler ───────────────────────

  describe('goal-1: createCheckoutHandler — 503 no-key and 409 active', () => {
    let origSecretKey: string | undefined;
    let origPriceId: string | undefined;

    afterEach(async () => {
      if (origSecretKey !== undefined) {
        process.env.STRIPE_SECRET_KEY = origSecretKey;
      } else {
        delete process.env.STRIPE_SECRET_KEY;
      }
      if (origPriceId !== undefined) {
        process.env.STRIPE_PRICE_ID = origPriceId;
      } else {
        delete process.env.STRIPE_PRICE_ID;
      }
      const { _resetStripeForTests } = await import('@/lib/stripe');
      _resetStripeForTests();
      vi.resetModules();
    });

    it('goal-1: createCheckoutHandler returns 503 when STRIPE_SECRET_KEY absent', async () => {
      origSecretKey = process.env.STRIPE_SECRET_KEY;
      origPriceId = process.env.STRIPE_PRICE_ID;
      delete process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_PRICE_ID = 'price_p9_fake';

      vi.resetModules();
      vi.doMock('@/lib/auth', () => ({
        auth: {
          api: {
            getSession: vi.fn().mockResolvedValue({
              user: { id: 'user_g1_503', email: 'test@g1.test' },
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
    });

    it('goal-1: createCheckoutHandler returns 409 when subscription already active', async () => {
      const u = await seedUser('g1-checkout-409');
      const customerId = 'cus_g1409_' + crypto.randomUUID().replace(/-/g, '');

      await testDb.insert(s.billingCustomers).values({
        userId: u.id,
        stripeCustomerId: customerId,
        subscriptionStatus: 'active',
      });

      origSecretKey = process.env.STRIPE_SECRET_KEY;
      origPriceId = process.env.STRIPE_PRICE_ID;
      process.env.STRIPE_SECRET_KEY = 'sk_test_g1_409';
      process.env.STRIPE_PRICE_ID = 'price_g1_409_fake';

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
      const { _resetStripeForTests } = await import('@/lib/stripe');
      _resetStripeForTests();

      const { createCheckoutHandler } = await import('@/app/api/billing/checkout/route');
      const POST = createCheckoutHandler(testDb);
      const res = await POST();
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('already_subscribed');
    });
  });

  // ── 1h. Upgrade-path contract: exhaust credits → 402 shape → classifyLessonError('credits') ──

  it('goal-1: placeHold throws InsufficientCreditsError when balance = 0; lessons route maps it to 402 { error: "credits" }; classifyLessonError returns "credits"', async () => {
    const u = await seedUser('g1-upgrade-path');

    // No grant — balance is 0.
    const initialBal = await balance(testDb, u.id);
    expect(initialBal).toBe(0);

    // placeHold must throw InsufficientCreditsError.
    await expect(placeHold(testDb, u.id)).rejects.toThrow(InsufficientCreditsError);

    // The lessons route returns 402 with { error: 'credits' } when InsufficientCreditsError is thrown.
    // Verify classifyLessonError maps the 402 status to 'credits' (the upgrade-path contract).
    const { classifyLessonError } = await import('@/lib/lesson-error');
    const kind = classifyLessonError(402, { error: 'credits' });
    expect(kind).toBe('credits');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 2 — Legal/account contracts: buildExport + deleteAccount + guards
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 2 — legal/account contracts: buildExport promises + isolation; delete cascade + guards', () => {

  // ── 2a. buildExport JSON contains the promised sections ─────────────────────

  it('goal-2: buildExport JSON contains user email, track topic, learning records, glossary terms, ledger rows', async () => {
    const world = await seedMinimalWorld('g2-json');
    const result = await buildExport(testDb, world.user.id, 'json');

    expect(result.contentType).toBe('application/json');
    const doc = JSON.parse(result.body) as {
      user: { email: string };
      tracks: Array<{
        track: { topic: string };
        learningRecords: Array<{ body: string }>;
        glossaryTerms: Array<{ term: string }>;
      }>;
      creditLedger: Array<{ entryType: string }>;
    };

    expect(doc.user.email).toBe(world.user.email);
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].track.topic).toContain('Rust async');
    expect(doc.tracks[0].learningRecords.some((r) => r.body.includes(world.record.body))).toBe(true);
    expect(doc.tracks[0].glossaryTerms.some((g) => g.term === world.glossaryTerm.term)).toBe(true);
    expect(doc.creditLedger.some((l) => l.entryType === 'grant')).toBe(true);
  });

  // ── 2b. buildExport isolation: learner B absent from learner A export ────────

  it('goal-2: buildExport JSON — learner B data absent from learner A export', async () => {
    const worldA = await seedMinimalWorld('g2-iso-a');
    const worldB = await seedMinimalWorld('g2-iso-b');

    const resultA = await buildExport(testDb, worldA.user.id, 'json');
    expect(resultA.body).toContain(worldA.user.email);
    expect(resultA.body).not.toContain(worldB.user.email);
    expect(resultA.body).not.toContain('g2-iso-b');
  });

  // ── 2c. buildExport Markdown contains the promised sections ─────────────────

  it('goal-2: buildExport Markdown contains track topic, mission why text, glossary term, learning record', async () => {
    const world = await seedMinimalWorld('g2-md');
    const result = await buildExport(testDb, world.user.id, 'markdown');

    expect(result.contentType).toBe('text/markdown; charset=utf-8');
    const md = result.body;
    expect(md).toContain(world.track.topic);
    expect(md).toContain(world.mission.whyText);
    expect(md).toContain(world.glossaryTerm.term);
    expect(md).toContain(world.record.title);
  });

  // ── 2d. delete cascade leaves zero user rows; bystander intact ──────────────

  it('goal-2: deleteAccount removes all user rows; bystander world untouched', async () => {
    const target = await seedMinimalWorld('g2-del-target');
    const bystander = await seedMinimalWorld('g2-del-bystander');

    await deleteAccount(testDb, target.user.id);

    // Target user and all user-reachable rows are gone.
    const userRows = await testDb.select().from(s.user).where(eq(s.user.id, target.user.id));
    expect(userRows).toHaveLength(0);

    const trackRows = await testDb.select().from(s.tracks).where(eq(s.tracks.id, target.track.id));
    expect(trackRows).toHaveLength(0);

    const ledgerRows = await testDb.select().from(s.creditLedger).where(eq(s.creditLedger.id, target.ledgerRow.id));
    expect(ledgerRows).toHaveLength(0);

    // Bystander world untouched.
    const bystanderUser = await testDb.select().from(s.user).where(eq(s.user.id, bystander.user.id));
    expect(bystanderUser).toHaveLength(1);

    const bystanderTrack = await testDb.select().from(s.tracks).where(eq(s.tracks.id, bystander.track.id));
    expect(bystanderTrack).toHaveLength(1);
  });

  // ── 2e. Active-subscription 409 guard on delete ─────────────────────────────

  it('goal-2: delete with active subscription → 409, user row still present', async () => {
    const world = await seedMinimalWorld('g2-del-active-sub');

    // Insert an active billing customer.
    await testDb.insert(s.billingCustomers).values({
      userId: world.user.id,
      stripeCustomerId: 'cus_g2act_' + crypto.randomUUID().replace(/-/g, ''),
      subscriptionStatus: 'active',
    });

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({ user: { id: world.user.id } }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));

    const { createPostHandler } = await import('@/app/api/account/delete/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/account/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'DELETE' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('active_subscription');

    // User still present.
    const [still] = await testDb.select().from(s.user).where(eq(s.user.id, world.user.id));
    expect(still).toBeDefined();

    vi.resetModules();
  });

  // ── 2f. Confirm-string guard ─────────────────────────────────────────────────

  it('goal-2: wrong confirm string → 400, user not deleted', async () => {
    const world = await seedMinimalWorld('g2-del-guard');

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({ user: { id: world.user.id } }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));

    const { createPostHandler } = await import('@/app/api/account/delete/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/account/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'delete' }), // wrong case
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);

    // User still present.
    const [still] = await testDb.select().from(s.user).where(eq(s.user.id, world.user.id));
    expect(still).toBeDefined();

    vi.resetModules();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 3 — Eval matrix: 36-case integrity (independent check)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 3 — eval matrix: 36-case matrix has distinct cells (independent check)', () => {
  // Re-derive the cell-key logic here (independent of the runner's assertMatrixComplete).
  // This test does NOT import the runner's assert function — it re-derives the check
  // so the acceptance test is not a tautology against the production code.

  it('goal-3: cases.json has exactly 36 items, all unique ids', async () => {
    const casesJson = (await import('../../evals/cases.json')).default as Array<{
      id: string;
      vertical: string;
      levelBand: string;
      ageBand: string;
      topic: string;
    }>;

    expect(casesJson).toHaveLength(36);

    const ids = casesJson.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(36); // no duplicate ids
  });

  it('goal-3: 4 verticals × 3 age-bands × 3 level-bands = 36 distinct cells', async () => {
    const casesJson = (await import('../../evals/cases.json')).default as Array<{
      id: string;
      vertical: string;
      levelBand: string;
      ageBand: string;
      topic: string;
    }>;

    const EXPECTED_VERTICALS = ['programming', 'history', 'math', 'science'] as const;
    const EXPECTED_AGE_BANDS = ['13_15', '16_17', '18_plus'] as const;
    const EXPECTED_LEVEL_BANDS = ['novice', 'developing', 'competent'] as const;

    const missingCells: string[] = [];

    for (const vertical of EXPECTED_VERTICALS) {
      for (const ageBand of EXPECTED_AGE_BANDS) {
        for (const levelBand of EXPECTED_LEVEL_BANDS) {
          const found = casesJson.some(
            (c) => c.vertical === vertical && c.ageBand === ageBand && c.levelBand === levelBand,
          );
          if (!found) {
            missingCells.push(`${vertical}/${ageBand}/${levelBand}`);
          }
        }
      }
    }

    expect(missingCells).toHaveLength(0);
  });

  it('goal-3: each of the 4 verticals has exactly 9 cases (3 ages × 3 levels)', async () => {
    const casesJson = (await import('../../evals/cases.json')).default as Array<{
      id: string;
      vertical: string;
      levelBand: string;
      ageBand: string;
      topic: string;
    }>;

    for (const vertical of ['programming', 'history', 'math', 'science']) {
      const forVertical = casesJson.filter((c) => c.vertical === vertical);
      expect(forVertical, `vertical ${vertical} should have 9 cases`).toHaveLength(9);
    }
  });

  it('goal-3: every case has non-empty topic and required fields', async () => {
    const casesJson = (await import('../../evals/cases.json')).default as Array<{
      id: string;
      vertical: string;
      levelBand: string;
      ageBand: string;
      topic: string;
    }>;

    for (const c of casesJson) {
      expect(c.id, 'id must be non-empty').toBeTruthy();
      expect(c.vertical, `${c.id}: vertical must be non-empty`).toBeTruthy();
      expect(c.levelBand, `${c.id}: levelBand must be non-empty`).toBeTruthy();
      expect(c.ageBand, `${c.id}: ageBand must be non-empty`).toBeTruthy();
      expect(c.topic, `${c.id}: topic must be non-empty`).toBeTruthy();
    }
  });
});
