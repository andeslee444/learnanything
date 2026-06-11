/**
 * Billing UI tests — Phase 9 Task 2.
 *
 * Tests (real DB, no tautologies):
 *
 * 1. getLedgerHistory: returns rows newest-first; no raw stripeRef exposed.
 * 2. getLedgerHistory: limit=25 ordering — seeds 30 rows, expects exactly 25,
 *    newest at index 0.
 * 3. getLedgerHistory: hasStripeRef boolean — true for purchase, false for grant.
 * 4. getLedgerHistory: empty for unknown userId.
 * 5. getSubscriptionStatus: returns 'none' when no billing_customers row.
 * 6. getSubscriptionStatus: returns 'active' after insert.
 * 7. getSubscriptionStatus: returns 'canceled' after update.
 *
 * 8. classifyLessonError: 402 → 'credits'; 409/already_generating → 'already_generating';
 *    409/unknown → 'error'; 200 → null; 500/unexpected status → 'error'.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getLedgerHistory, getSubscriptionStatus } from '@/lib/billing-queries';
import { classifyLessonError } from '@/lib/lesson-error';
import { friendlyBillingError } from '@/lib/billing-error';

// ── Pool lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  await resetDb();
});
afterAll(() => testPool.end());

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedUser(tag: string) {
  const [u] = await testDb
    .insert(s.user)
    .values({
      id: crypto.randomUUID(),
      name: 'BillingUI-' + tag,
      email: `${crypto.randomUUID()}@billing-ui.test`,
    })
    .returning();
  return u;
}

// ── 1. getLedgerHistory basic ──────────────────────────────────────────────────

describe('getLedgerHistory', () => {
  it('1. returns rows newest-first; hasStripeRef set correctly', async () => {
    const u = await seedUser('lh-basic');

    // Insert a grant (no stripeRef) then a purchase (with stripeRef) — slightly
    // different timestamps since DB uses defaultNow(). Spread inserts so created_at order is distinct.
    await testDb.insert(s.creditLedger).values({
      userId: u.id,
      entryType: 'grant',
      amount: 3,
    });
    // Small delay is not needed — we can just insert with explicit timestamps.
    // But to guarantee order determinism without a sleep we insert in ascending
    // time order and assert descending. The query uses ORDER BY created_at DESC.
    await testDb.insert(s.creditLedger).values({
      userId: u.id,
      entryType: 'purchase',
      amount: 30,
      stripeRef: 'in_test_' + crypto.randomUUID().replace(/-/g, ''),
    });

    const rows = await getLedgerHistory(testDb, u.id, 25);
    // Should have at least 2 rows.
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // purchase (latest) should be first.
    expect(rows[0].entryType).toBe('purchase');
    expect(rows[0].hasStripeRef).toBe(true);

    // grant should be second.
    const grantRow = rows.find((r) => r.entryType === 'grant');
    expect(grantRow).toBeDefined();
    expect(grantRow!.hasStripeRef).toBe(false);

    // NO raw stripeRef in the returned type — confirm the key doesn't exist.
    expect('stripeRef' in rows[0]).toBe(false);
  });

  it('2. limit=25: seeds 30 rows, returns exactly 25, newest first', async () => {
    const u = await seedUser('lh-limit');

    // Insert 30 grant rows sequentially (same type, different amounts not valid for grant — use purchase with fake refs).
    const rows30 = Array.from({ length: 30 }, (_, i) => ({
      userId: u.id,
      entryType: 'purchase' as const,
      amount: i + 1,
      stripeRef: `in_limit_${i}_${crypto.randomUUID().replace(/-/g, '')}`,
    }));
    // Insert one at a time to get distinct created_at timestamps (Postgres defaultNow() resolution is microseconds).
    for (const row of rows30) {
      await testDb.insert(s.creditLedger).values(row);
    }

    const result = await getLedgerHistory(testDb, u.id, 25);
    expect(result).toHaveLength(25);

    // First row must be the most-recently inserted (amount = 30 in this user's subset).
    // The amounts go 1..30; newest is amount=30.
    expect(result[0].amount).toBe(30);
    // Last visible is amount=6 (30 - 25 + 1).
    expect(result[24].amount).toBe(6);
  });

  it('3. hasStripeRef: purchase row has true, grant row has false', async () => {
    const u = await seedUser('lh-striperef');

    await testDb.insert(s.creditLedger).values({
      userId: u.id,
      entryType: 'grant',
      amount: 3,
    });
    await testDb.insert(s.creditLedger).values({
      userId: u.id,
      entryType: 'purchase',
      amount: 30,
      stripeRef: 'in_sr_' + crypto.randomUUID().replace(/-/g, ''),
    });

    const rows = await getLedgerHistory(testDb, u.id, 10);
    const purchase = rows.find((r) => r.entryType === 'purchase');
    const grant = rows.find((r) => r.entryType === 'grant');

    expect(purchase!.hasStripeRef).toBe(true);
    expect(grant!.hasStripeRef).toBe(false);
  });

  it('4. returns empty array for userId with no rows', async () => {
    const rows = await getLedgerHistory(testDb, 'user_nonexistent_' + crypto.randomUUID(), 25);
    expect(rows).toEqual([]);
  });
});

// ── 5-7. getSubscriptionStatus ────────────────────────────────────────────────

describe('getSubscriptionStatus', () => {
  it('5. returns "none" when no billing_customers row exists', async () => {
    const status = await getSubscriptionStatus(testDb, 'user_none_' + crypto.randomUUID());
    expect(status).toBe('none');
  });

  it('6. returns "active" after billing_customers insert with active status', async () => {
    const u = await seedUser('status-active');
    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: 'cus_active_' + crypto.randomUUID().replace(/-/g, ''),
      subscriptionStatus: 'active',
    });

    const status = await getSubscriptionStatus(testDb, u.id);
    expect(status).toBe('active');
  });

  it('7. returns "canceled" after status update to canceled', async () => {
    const u = await seedUser('status-canceled');
    await testDb.insert(s.billingCustomers).values({
      userId: u.id,
      stripeCustomerId: 'cus_canceled_' + crypto.randomUUID().replace(/-/g, ''),
      subscriptionStatus: 'active',
    });

    await testDb
      .update(s.billingCustomers)
      .set({ subscriptionStatus: 'canceled' })
      .where(eq(s.billingCustomers.userId, u.id));

    const status = await getSubscriptionStatus(testDb, u.id);
    expect(status).toBe('canceled');
  });
});

// ── 8. friendlyBillingError ───────────────────────────────────────────────────

describe('friendlyBillingError', () => {
  it('8a. "unauthenticated" → session-expired message', () => {
    expect(friendlyBillingError('unauthenticated')).toBe('Your session expired — please sign in again.');
  });

  it('8b. "no_subscription" → no-subscription message', () => {
    expect(friendlyBillingError('no_subscription')).toBe('No subscription found.');
  });

  it('8c. unknown code → generic fallback', () => {
    expect(friendlyBillingError('some_unknown_code')).toBe('Something went wrong — please try again.');
  });

  it('8d. undefined → generic fallback', () => {
    expect(friendlyBillingError(undefined)).toBe('Something went wrong — please try again.');
  });
});

// ── 9. classifyLessonError ────────────────────────────────────────────────────

describe('classifyLessonError', () => {
  it('8a. 402 → "credits"', () => {
    expect(classifyLessonError(402, null)).toBe('credits');
  });

  it('8b. 409 + already_generating body → "already_generating"', () => {
    expect(classifyLessonError(409, { error: 'already_generating' })).toBe('already_generating');
  });

  it('8c. 409 + other body → "error"', () => {
    expect(classifyLessonError(409, { error: 'track_not_initialized' })).toBe('error');
  });

  it('8d. 200 → null (no error)', () => {
    expect(classifyLessonError(200, null)).toBeNull();
  });

  it('8e. unexpected status → "error"', () => {
    expect(classifyLessonError(500, null)).toBe('error');
  });
});
