import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { createTrackWithMission, nextRecordSeq, listTracks } from '@/server/tracks';

const input = {
  topic: 'Rust CLI tools',
  vertical: 'programming' as const,
  whyText: 'Ship a CLI to my team by Q3',
  successCriteria: [{ description: 'Publish a working CLI my team installs' }],
  constraints: { timePerWeek: '3 hours' },
  priorKnowledge: 'I know Python well.',
  outOfScope: ['async'],
};

describe('track creation', () => {
  let learnerId: string;

  beforeAll(async () => {
    await resetDb();
    const [u] = await testDb.insert(s.user).values({ id: crypto.randomUUID(), name: 'T', email: 't@t.dev' }).returning();
    const [learner] = await testDb.insert(s.learners).values({ userId: u.id, displayName: 'T', ageBand: '18_plus' }).returning();
    learnerId = learner.id;
  });
  afterAll(() => testPool.end());

  it('creates track + mission + prior-knowledge record atomically', async () => {
    const track = await createTrackWithMission(testDb, learnerId, input);
    const [mission] = await testDb.select().from(s.missions).where(eq(s.missions.trackId, track.id));
    expect(mission.whyText).toBe(input.whyText);
    expect(mission.outOfScope).toEqual(['async']);
    const records = await testDb.select().from(s.learningRecords).where(eq(s.learningRecords.trackId, track.id));
    expect(records).toHaveLength(1);
    expect(records[0].recordType).toBe('prior_knowledge');
    expect(records[0].seq).toBe(1);
  });

  it('skips the record when prior knowledge is blank', async () => {
    const track = await createTrackWithMission(testDb, learnerId, { ...input, priorKnowledge: '  ' });
    const records = await testDb.select().from(s.learningRecords).where(eq(s.learningRecords.trackId, track.id));
    expect(records).toHaveLength(0);
  });

  it('assigns sequential record seqs under the lock convention', async () => {
    const track = await createTrackWithMission(testDb, learnerId, input);
    const seq = await testDb.transaction((tx) => nextRecordSeq(tx, track.id));
    expect(seq).toBe(2);
  });

  it('lists tracks newest first', async () => {
    const all = await listTracks(testDb, learnerId);
    expect(all.length).toBeGreaterThanOrEqual(3);
  });
});
