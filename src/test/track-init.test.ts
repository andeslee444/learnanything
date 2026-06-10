import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { createTrackWithMission } from '@/server/tracks';
import { initializeTrack } from '@/server/track-init';

describe('track initialization (fake LLM)', () => {
  let trackId: string;

  beforeEach(() => { process.env.AI_FAKE_LLM = '1'; });
  beforeAll(async () => {
    await resetDb();
    const [u] = await testDb.insert(s.user).values({ id: crypto.randomUUID(), name: 'I', email: 'i@t.dev' }).returning();
    const [learner] = await testDb.insert(s.learners).values({ userId: u.id, displayName: 'I', ageBand: '18_plus' }).returning();
    const track = await createTrackWithMission(testDb, learner.id, {
      topic: 'Python CLI tools', vertical: 'programming', whyText: 'ship a CLI',
      successCriteria: [{ description: 'CLI my team uses' }], constraints: {}, outOfScope: [],
    });
    trackId = track.id;
  });
  afterAll(() => testPool.end());

  it('persists a validated graph and returns a quiz', async () => {
    const result = await initializeTrack(testDb, trackId);
    expect(result.status).toBe('initialized');
    if (result.status !== 'initialized') return;
    expect(result.nodeCount).toBe(10);
    expect(result.quiz.items.length).toBeGreaterThanOrEqual(2);
    const nodes = await testDb.select().from(s.skillNodes).where(eq(s.skillNodes.trackId, trackId));
    expect(nodes).toHaveLength(10);
    const edges = await testDb.select().from(s.skillNodeEdges);
    expect(edges.length).toBe(10);
  });

  it('is idempotent', async () => {
    const again = await initializeTrack(testDb, trackId);
    expect(again.status).toBe('already_initialized');
  });

  it('fails cleanly when the graph violates out-of-scope (retry exhausted)', async () => {
    // The fixture contains a node "Error handling" — declare it out of scope to force failure both attempts.
    const [u] = await testDb.insert(s.user).values({ id: crypto.randomUUID(), name: 'I2', email: 'i2@t.dev' }).returning();
    const [learner] = await testDb.insert(s.learners).values({ userId: u.id, displayName: 'I2', ageBand: '18_plus' }).returning();
    const track = await createTrackWithMission(testDb, learner.id, {
      topic: 'Python', vertical: 'programming', whyText: 'x', successCriteria: [{ description: 'y' }],
      constraints: {}, outOfScope: ['error handling'],
    });
    const result = await initializeTrack(testDb, track.id);
    expect(result.status).toBe('failed');
    const nodes = await testDb.select().from(s.skillNodes).where(eq(s.skillNodes.trackId, track.id));
    expect(nodes).toHaveLength(0); // nothing persisted on failure
  });
});
