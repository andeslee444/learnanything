import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { ensureMonthlyGrant, balance, placeHold, captureHold, refundHold, InsufficientCreditsError, FREE_MONTHLY_GRANT } from './credits';

async function seedUser() {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'C', email: `${crypto.randomUUID()}@t.dev` })
    .returning();
  return u.id;
}

describe('credit ledger', () => {
  beforeEach(resetDb);
  afterAll(() => testPool.end());

  it('grants the free tier once per calendar month (idempotent)', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    await ensureMonthlyGrant(testDb, userId); // second call: no-op
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT);
  });

  it('hold → capture consumes one credit', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    const holdId = await placeHold(testDb, userId);
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT - 1);
    await captureHold(testDb, holdId);
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT - 1);
  });

  it('hold → refund restores the credit', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    const holdId = await placeHold(testDb, userId);
    await refundHold(testDb, holdId);
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT);
  });

  it('rejects a hold at zero balance', async () => {
    const userId = await seedUser(); // no grant
    await expect(placeHold(testDb, userId)).rejects.toThrow(InsufficientCreditsError);
  });

  it('refunding twice is rejected', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    const holdId = await placeHold(testDb, userId);
    await refundHold(testDb, holdId);
    await expect(refundHold(testDb, holdId)).rejects.toThrow(/already settled/i);
  });

  it('concurrent holds with balance 1: exactly one succeeds', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    const holdA = await placeHold(testDb, userId);
    await captureHold(testDb, holdA);
    const holdB = await placeHold(testDb, userId);
    await captureHold(testDb, holdB); // balance now 1
    const results = await Promise.allSettled([placeHold(testDb, userId), placeHold(testDb, userId)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditsError);
  });

  it('concurrent refunds of one hold: exactly one succeeds', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    const holdId = await placeHold(testDb, userId);
    const results = await Promise.allSettled([refundHold(testDb, holdId), refundHold(testDb, holdId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT);
  });

  it('concurrent monthly grants: balance is exactly one grant', async () => {
    const userId = await seedUser();
    await Promise.all([ensureMonthlyGrant(testDb, userId), ensureMonthlyGrant(testDb, userId)]);
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT);
  });
});
