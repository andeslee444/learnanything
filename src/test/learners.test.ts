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
    const err = await testDb.insert(s.glossaryTerms).values({
      trackId: track.id, term: 'ownership', definition: 'Each value has a single owning binding.',
      // promotionEvidenceRecordId intentionally missing
    } as never).catch((e: unknown) => e);
    const msg = String(
      err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error).message
    );
    expect(msg).toMatch(/null value|not-null|violates/i);
  });

  it('accepts a glossary term whose evidence record is in the same track', async () => {
    const { track } = await seedLearnerTrack();
    const [record] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id, seq: 1, recordType: 'demonstrated_understanding',
        title: 'Ownership demonstrated', body: 'Explained ownership correctly twice.',
      })
      .returning();
    const [term] = await testDb
      .insert(s.glossaryTerms)
      .values({
        trackId: track.id, term: 'ownership', definition: 'Each value has a single owning binding.',
        promotionEvidenceRecordId: record.id,
      })
      .returning();
    expect(term.term).toBe('ownership');
  });

  it('rejects a glossary term whose evidence record belongs to another track', async () => {
    const a = await seedLearnerTrack();
    const b = await seedLearnerTrack();
    const [foreignRecord] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: b.track.id, seq: 1, recordType: 'demonstrated_understanding',
        title: 'Other-track record', body: 'Evidence from a different track.',
      })
      .returning();
    await expect(
      testDb.insert(s.glossaryTerms).values({
        trackId: a.track.id, term: 'leak', definition: 'x',
        promotionEvidenceRecordId: foreignRecord.id,
      })
    ).rejects.toThrow();
  });

  it('updated_at trigger fires on mission update', async () => {
    const { track } = await seedLearnerTrack();
    const [mission] = await testDb
      .insert(s.missions)
      .values({ trackId: track.id, whyText: 'before' })
      .returning();
    await new Promise((r) => setTimeout(r, 10));
    await testDb.update(s.missions).set({ whyText: 'after' }).where(eq(s.missions.id, mission.id));
    const [reloaded] = await testDb.select().from(s.missions).where(eq(s.missions.id, mission.id));
    expect(reloaded.updatedAt.getTime()).toBeGreaterThan(mission.updatedAt.getTime());
  });

  it('deleting parent user sets parentUserId to null on child learner (set null cascade)', async () => {
    // Seed user A (the child) with a learner whose parentUserId points to user B.
    const [userA] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'ChildUser', email: `${crypto.randomUUID()}@t.dev` })
      .returning();
    const [userB] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'ParentUser', email: `${crypto.randomUUID()}@t.dev` })
      .returning();
    const [learnerA] = await testDb
      .insert(s.learners)
      .values({ userId: userA.id, displayName: 'ChildLearner', ageBand: '18_plus', parentUserId: userB.id })
      .returning();

    // Delete user B (the parent).
    await testDb.delete(s.user).where(eq(s.user.id, userB.id));

    // Learner A must survive with parentUserId set to null.
    const [reloaded] = await testDb.select().from(s.learners).where(eq(s.learners.id, learnerA.id));
    expect(reloaded).toBeDefined();
    expect(reloaded.parentUserId).toBeNull();

    // User A must still exist.
    const [stillA] = await testDb.select().from(s.user).where(eq(s.user.id, userA.id));
    expect(stillA).toBeDefined();
  });

  it('deleting a track cascades to its records and glossary', async () => {
    const { track } = await seedLearnerTrack();
    const [record] = await testDb
      .insert(s.learningRecords)
      .values({ trackId: track.id, seq: 1, recordType: 'prior_knowledge', title: 't', body: 'b' })
      .returning();
    await testDb.insert(s.glossaryTerms).values({
      trackId: track.id, term: 'cascade-test', definition: 'd', promotionEvidenceRecordId: record.id,
    });
    await testDb.delete(s.tracks).where(eq(s.tracks.id, track.id));
    const records = await testDb.select().from(s.learningRecords).where(eq(s.learningRecords.trackId, track.id));
    const terms = await testDb.select().from(s.glossaryTerms).where(eq(s.glossaryTerms.trackId, track.id));
    expect(records).toHaveLength(0);
    expect(terms).toHaveLength(0);
  });
});
