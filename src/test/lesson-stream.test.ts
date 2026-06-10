/**
 * Integration tests for Task 1 of Phase 4b:
 * - resolveStreamRunId guard logic (ownership, 404/409 semantics)
 * - runId persistence in zpdSnapshot after stagePlan
 * - spec (objective + blockOutline) persisted by stagePlan so outline-early UX can render
 *
 * Does NOT test the HTTP handler itself (that needs a running Next.js server),
 * but the guard logic is exported as resolveStreamRunId(db, lessonId, learnerId)
 * and exercised directly here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { createLessonRow, stagePlan } from '@/server/lessons/pipeline';
import { resolveStreamRunId } from '@/app/api/lessons/[lessonId]/stream/route';

// ── seed helpers ──────────────────────────────────────────────────────────────

async function seedMinimalTrack(email: string) {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'S', email })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'S', ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Stream test topic', vertical: 'programming', expertiseBand: 'novice' })
    .returning();
  await testDb.insert(s.missions).values({
    trackId: track.id,
    whyText: 'test',
    successCriteria: [{ description: 'ok' }],
    constraints: {},
    outOfScope: [],
  });
  return { userId: u.id, learnerId: learner.id, trackId: track.id };
}

async function seedTrackWithNode(email: string) {
  const base = await seedMinimalTrack(email);
  await testDb.insert(s.skillNodes).values({
    trackId: base.trackId,
    name: 'Variables',
    summary: 'Using variables',
    missionRelevance: 0.9,
  });
  await testDb.insert(s.trustDomains).values([
    { vertical: 'programming', domain: 'docs.python.org', tier: 'tier1', note: 'test' },
  ]).onConflictDoNothing();
  return base;
}

// ── shared env ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
});
afterAll(() => testPool.end());

// ── Guard: 404 — lesson not found ─────────────────────────────────────────────

describe('resolveStreamRunId guards', () => {
  let learnerId: string;
  let trackId: string;

  beforeAll(async () => {
    const seed = await seedMinimalTrack('stream-guards@t.dev');
    learnerId = seed.learnerId;
    trackId = seed.trackId;
  });

  it('returns 404 when lessonId does not exist', async () => {
    const result = await resolveStreamRunId(testDb, crypto.randomUUID(), learnerId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toBe('not found');
    }
  });

  it('returns 404 when lesson belongs to a different learner', async () => {
    // Create another learner/track/lesson
    const [u2] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'Other', email: 'stream-other@t.dev' })
      .returning();
    const [otherLearner] = await testDb
      .insert(s.learners)
      .values({ userId: u2.id, displayName: 'Other', ageBand: '18_plus' })
      .returning();
    const [otherTrack] = await testDb
      .insert(s.tracks)
      .values({ learnerId: otherLearner.id, topic: 'Other topic', vertical: 'programming' })
      .returning();
    const [otherLesson] = await testDb
      .insert(s.lessons)
      .values({ trackId: otherTrack.id, seq: 1, spec: {}, status: 'generating' })
      .returning();

    // learnerId belongs to the first learner — should NOT be able to access other's lesson
    const result = await resolveStreamRunId(testDb, otherLesson.id, learnerId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('returns 409 when lesson status is ready (terminal)', async () => {
    const [readyLesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'ready' })
      .returning();

    const result = await resolveStreamRunId(testDb, readyLesson.id, learnerId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe('lesson_terminal');
    }
  });

  it('returns 409 when lesson status is failed (terminal)', async () => {
    const [failedLesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 2, spec: {}, status: 'failed' })
      .returning();

    const result = await resolveStreamRunId(testDb, failedLesson.id, learnerId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe('lesson_terminal');
    }
  });

  it('returns 404 (run_not_started) when generating lesson has no workflowRunId in zpdSnapshot', async () => {
    // Use a fresh track so lessons_one_generating_per_track doesn't conflict.
    const seed2 = await seedMinimalTrack('stream-gen-no-runid@t.dev');
    const [genLesson] = await testDb
      .insert(s.lessons)
      .values({ trackId: seed2.trackId, seq: 1, spec: {}, status: 'generating', zpdSnapshot: {} })
      .returning();

    const result = await resolveStreamRunId(testDb, genLesson.id, seed2.learnerId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toBe('run_not_started');
    }
  });

  it('returns ok + runId when generating lesson has workflowRunId in zpdSnapshot', async () => {
    // Use a fresh track so lessons_one_generating_per_track doesn't conflict.
    const seed3 = await seedMinimalTrack('stream-gen-with-runid@t.dev');
    const fakeRunId = 'run_test_' + crypto.randomUUID();
    const [genLesson] = await testDb
      .insert(s.lessons)
      .values({
        trackId: seed3.trackId,
        seq: 1,
        spec: {},
        status: 'generating',
        zpdSnapshot: { workflowRunId: fakeRunId },
      })
      .returning();

    const result = await resolveStreamRunId(testDb, genLesson.id, seed3.learnerId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId).toBe(fakeRunId);
    }
  });
});

// ── Spec persistence: stagePlan writes objective + blockOutline ───────────────

describe('stagePlan spec persistence — outline-early data availability', () => {
  it('after stagePlan, lesson.spec has objective and blockOutline', async () => {
    const { trackId } = await seedTrackWithNode('stream-spec-persist@t.dev');
    const lesson = await createLessonRow(testDb, trackId);

    const result = await stagePlan(testDb, lesson.id);
    expect(result.status).toBe('planned');

    const [updated] = await testDb
      .select({ spec: s.lessons.spec })
      .from(s.lessons)
      .where(eq(s.lessons.id, lesson.id));

    const spec = updated.spec as Record<string, unknown>;
    // objective is the primary field for the outline-early render
    expect(typeof spec.objective).toBe('string');
    expect((spec.objective as string).length).toBeGreaterThan(0);
    // blockOutline is the ordered list of block summaries
    expect(Array.isArray(spec.blockOutline)).toBe(true);
    expect((spec.blockOutline as unknown[]).length).toBeGreaterThan(0);
  });
});

// ── zpdSnapshot merge: workflowRunId does not clobber existing fields ─────────

describe('zpdSnapshot merge — workflowRunId does not clobber existing fields', () => {
  it('existing nodeId/nodeName/expertiseBand survive after runId written', async () => {
    const { trackId, learnerId } = await seedMinimalTrack('stream-merge@t.dev');
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({
        trackId,
        seq: 1,
        spec: {},
        status: 'generating',
        zpdSnapshot: { nodeId: 'node-abc', nodeName: 'Loops', expertiseBand: 'novice' },
      })
      .returning();

    // Simulate what the create route does: merge workflowRunId into the existing snapshot.
    const existingSnapshot = lesson.zpdSnapshot as Record<string, unknown>;
    const fakeRunId = 'run_merge_' + crypto.randomUUID();
    await testDb
      .update(s.lessons)
      .set({ zpdSnapshot: { ...existingSnapshot, workflowRunId: fakeRunId } })
      .where(eq(s.lessons.id, lesson.id));

    const [updated] = await testDb
      .select({ zpd: s.lessons.zpdSnapshot })
      .from(s.lessons)
      .where(eq(s.lessons.id, lesson.id));

    const zpd = updated.zpd as Record<string, unknown>;
    expect(zpd.nodeId).toBe('node-abc');
    expect(zpd.nodeName).toBe('Loops');
    expect(zpd.expertiseBand).toBe('novice');
    expect(zpd.workflowRunId).toBe(fakeRunId);

    // resolveStreamRunId should now return ok + runId for this learner.
    const streamResult = await resolveStreamRunId(testDb, lesson.id, learnerId);
    expect(streamResult.ok).toBe(true);
    if (streamResult.ok) expect(streamResult.runId).toBe(fakeRunId);
  });
});
