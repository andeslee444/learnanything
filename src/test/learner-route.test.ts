import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { createLearner, getLearnerByUserId } from '@/server/learners';

describe('learner creation', () => {
  beforeAll(resetDb);
  afterAll(() => testPool.end());

  it('creates once and is idempotent', async () => {
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'A', email: 'a@t.dev' })
      .returning();
    const first = await createLearner(testDb, { userId: u.id, displayName: 'A', ageBand: '18_plus' });
    const second = await createLearner(testDb, { userId: u.id, displayName: 'DIFFERENT', ageBand: '16_17' });
    expect(second.id).toBe(first.id);
    expect((await getLearnerByUserId(testDb, u.id))!.displayName).toBe('A');
  });
});
