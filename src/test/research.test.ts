import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, cosineDistance, desc } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed * (i + 1)));
}

describe('topic dossier cache', () => {
  beforeAll(resetDb);
  afterAll(() => testPool.end());

  it('stores and retrieves by cosine similarity', async () => {
    const target = fakeEmbedding(1);
    await testDb.insert(s.topicDossiers).values([
      {
        vertical: 'science', topic: 'photosynthesis intro', levelBand: 'novice',
        embedding: target, ttlExpiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        vertical: 'science', topic: 'thermodynamics', levelBand: 'novice',
        embedding: fakeEmbedding(99), ttlExpiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const similarity = sql<number>`1 - (${cosineDistance(s.topicDossiers.embedding, target)})`;
    const [best] = await testDb
      .select({ topic: s.topicDossiers.topic, similarity })
      .from(s.topicDossiers)
      .orderBy(desc(similarity))
      .limit(1);
    expect(best.topic).toBe('photosynthesis intro');
    expect(best.similarity).toBeGreaterThan(0.99);
  });

  it('keeps one tier row per (vertical, domain)', async () => {
    await testDb.insert(s.trustDomains).values({ vertical: 'programming', domain: 'developer.mozilla.org', tier: 'tier1' });
    const err = await testDb
      .insert(s.trustDomains)
      .values({ vertical: 'programming', domain: 'developer.mozilla.org', tier: 'tier2' })
      .catch((e: unknown) => e);
    const msg = String(
      err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error).message
    );
    expect(msg).toMatch(/duplicate key|unique|trust_domains_vertical_domain/i);
  });

  it('treats NULL vertical as a real value in the uniqueness rule (global blocklist)', async () => {
    await testDb.insert(s.trustDomains).values({ vertical: null, domain: 'content-farm.example', tier: 'blocked' });
    const err = await testDb
      .insert(s.trustDomains)
      .values({ vertical: null, domain: 'content-farm.example', tier: 'blocked' })
      .catch((e: unknown) => e);
    const msg = String(
      err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error).message
    );
    expect(msg).toMatch(/duplicate key|unique|trust_domains_vertical_domain/i);
  });
});
