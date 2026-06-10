import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';

async function seedLearnerTrack() {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'L', email: `${crypto.randomUUID()}@t.dev` })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'L', ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Rust CLI tools', vertical: 'programming' })
    .returning();
  return { learner, track };
}

describe('learner domain', () => {
  beforeAll(resetDb);
  afterAll(() => testPool.end());

  it('enforces one mission per track', async () => {
    const { track } = await seedLearnerTrack();
    await testDb.insert(s.missions).values({ trackId: track.id, whyText: 'ship a CLI to my team' });
    const err = await testDb
      .insert(s.missions)
      .values({ trackId: track.id, whyText: 'second mission' })
      .catch((e: unknown) => e);
    // Drizzle 0.45 wraps PG errors: outer message = "Failed query: …"; real message in .cause
    const msg = String(
      err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error).message
    );
    expect(msg).toMatch(/duplicate key|unique/i);
  });

  it('supports learning-record supersession', async () => {
    const { track } = await seedLearnerTrack();
    const [first] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id, seq: 1, recordType: 'prior_knowledge',
        title: 'Knows basic syntax', body: 'Claimed prior experience with Rust syntax.',
      })
      .returning();
    const [second] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id, seq: 2, recordType: 'corrected_misconception',
        title: 'Borrow checker misunderstanding corrected', body: 'Understood moves vs borrows.',
      })
      .returning();
    await testDb
      .update(s.learningRecords)
      .set({ status: 'superseded', supersededById: second.id })
      .where(eq(s.learningRecords.id, first.id));

    const [reloaded] = await testDb
      .select().from(s.learningRecords).where(eq(s.learningRecords.id, first.id));
    expect(reloaded.status).toBe('superseded');
    expect(reloaded.supersededById).toBe(second.id);
  });

  it('gates glossary terms on a promotion-evidence record', async () => {
    const { track } = await seedLearnerTrack();
    await expect(
      testDb.insert(s.glossaryTerms).values({
        trackId: track.id, term: 'ownership', definition: 'Each value has a single owning binding.',
        // promotionEvidenceRecordId intentionally missing
      } as never)
    ).rejects.toThrow();
  });
});
