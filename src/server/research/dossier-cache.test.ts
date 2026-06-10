import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, testPool, resetDb } from '@/test/db';
import { findDossier, saveDossier, ttlForVertical, TTL_DAYS_BY_VERTICAL } from './dossier-cache';
import { eq } from 'drizzle-orm';
import * as s from '@/db/schema';

const content = {
  sources: [{ url: 'https://docs.python.org/x', title: 'Python docs' }],
  claims: [{ claim: 'Variables store values under a name.', sourceUrls: ['https://docs.python.org/x'] }],
  glossarySeeds: [{ term: 'variable', definition: 'A named container for a value.' }],
  misconceptions: ['Variables are not the values themselves.'],
};

describe('dossier cache', () => {
  beforeEach(() => { process.env.AI_FAKE_LLM = '1'; });
  beforeAll(resetDb);
  afterAll(() => testPool.end());

  it('round-trips: save then find by the same topic', async () => {
    await saveDossier(testDb, { vertical: 'programming', topic: 'python variables intro', levelBand: 'novice' }, content, 'test-model');
    const hit = await findDossier(testDb, { vertical: 'programming', topic: 'python variables intro', levelBand: 'novice' });
    expect(hit).not.toBeNull();
    expect(hit!.claims).toHaveLength(1);
  });

  it('misses on a different topic, vertical, or band', async () => {
    expect(await findDossier(testDb, { vertical: 'programming', topic: 'rust ownership deep dive', levelBand: 'novice' })).toBeNull();
    expect(await findDossier(testDb, { vertical: 'history', topic: 'python variables intro', levelBand: 'novice' })).toBeNull();
    expect(await findDossier(testDb, { vertical: 'programming', topic: 'python variables intro', levelBand: 'competent' })).toBeNull();
  });

  it('misses on an expired dossier', async () => {
    const key = { vertical: 'programming', topic: 'expired topic', levelBand: 'novice' as const };
    const id = await saveDossier(testDb, key, content, 'test-model');
    await testDb.update(s.topicDossiers)
      .set({ ttlExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(s.topicDossiers.id, id));
    expect(await findDossier(testDb, key)).toBeNull();
  });

  it('applies per-vertical TTLs', () => {
    const now = new Date('2026-06-10T00:00:00Z');
    expect(ttlForVertical('programming', now).getTime() - now.getTime()).toBe(TTL_DAYS_BY_VERTICAL.programming * 86_400_000);
    expect(ttlForVertical('unknown-vertical', now).getTime() - now.getTime()).toBe(30 * 86_400_000);
  });
});
