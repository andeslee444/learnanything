import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';

describe('review cards', () => {
  let learnerId: string;
  let termId: string;
  let recordId: string;

  beforeAll(async () => {
    await resetDb();
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'R', email: 'review@t.dev' })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'R', ageBand: '18_plus' })
      .returning();
    learnerId = learner.id;
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId, topic: 'Photosynthesis', vertical: 'science' })
      .returning();
    const [record] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id, seq: 1, recordType: 'demonstrated_understanding',
        title: 'Light reactions', body: 'Explained the light-dependent reactions correctly.',
      })
      .returning();
    recordId = record.id;
    const [term] = await testDb
      .insert(s.glossaryTerms)
      .values({
        trackId: track.id, term: 'chlorophyll', definition: 'The light-absorbing pigment in chloroplasts.',
        promotionEvidenceRecordId: record.id,
      })
      .returning();
    termId = term.id;
  });

  afterAll(() => testPool.end());

  it('accepts a card with exactly one source', async () => {
    const [card] = await testDb
      .insert(s.reviewCards)
      .values({ learnerId, glossaryTermId: termId, due: new Date() })
      .returning();
    expect(card.state).toBe(0);
  });

  it('rejects a card with both sources (XOR check)', async () => {
    const err = await testDb
      .insert(s.reviewCards)
      .values({
        learnerId, glossaryTermId: termId, learningRecordId: recordId, due: new Date(),
      })
      .catch((e: unknown) => e);
    // Drizzle 0.45 wraps PG errors: outer message = "Failed query: …"; real message in .cause
    const msg = String(
      err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error).message
    );
    expect(msg).toMatch(/check constraint|review_cards_one_source/i);
  });

  it('rejects a card with no source (XOR check)', async () => {
    const err = await testDb
      .insert(s.reviewCards)
      .values({ learnerId, due: new Date() })
      .catch((e: unknown) => e);
    // Drizzle 0.45 wraps PG errors: outer message = "Failed query: …"; real message in .cause
    const msg = String(
      err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error).message
    );
    expect(msg).toMatch(/check constraint|review_cards_one_source/i);
  });
});
