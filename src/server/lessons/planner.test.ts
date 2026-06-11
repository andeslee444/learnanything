import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { hydrateTrackState, pickFrontierNode, buildOpenerItems, planLesson } from './planner';
import { lessonPlanSchema } from './blocks';
import type { TrackState } from './planner';

// ── unit helpers ───────────────────────────────────────────────────────────────

/** Build a minimal in-memory node (no DB). */
function makeNode(
  overrides: Partial<typeof s.skillNodes.$inferSelect> & { id: string; name: string },
): typeof s.skillNodes.$inferSelect {
  return {
    trackId: 'track-1',
    summary: null,
    missionRelevance: 0.5,
    mastery: 'not_started',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Build a minimal in-memory edge. */
function makeEdge(nodeId: string, prereqId: string): typeof s.skillNodeEdges.$inferSelect {
  return { nodeId, prereqId };
}

// ── pickFrontierNode ──────────────────────────────────────────────────────────

describe('pickFrontierNode — roots-only (nothing mastered)', () => {
  it('returns the root node with highest missionRelevance when there are no prerequisites', () => {
    const nodes = [
      makeNode({ id: 'a', name: 'A', missionRelevance: 0.7 }),
      makeNode({ id: 'b', name: 'B', missionRelevance: 0.9 }),
      makeNode({ id: 'c', name: 'C', missionRelevance: 0.5 }),
    ];
    // No edges — all are roots
    const result = pickFrontierNode({ nodes, edges: [] });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('b'); // highest missionRelevance
  });
});

describe('pickFrontierNode — prereq-gated node', () => {
  it('excludes a node while its prereq is not_started', () => {
    const nodes = [
      makeNode({ id: 'a', name: 'A', missionRelevance: 0.9, mastery: 'not_started' }),
      makeNode({ id: 'b', name: 'B', missionRelevance: 0.8, mastery: 'not_started' }),
    ];
    const edges = [makeEdge('b', 'a')]; // b requires a
    const result = pickFrontierNode({ nodes, edges });
    // Only 'a' is a frontier root; 'b' is gated behind 'a'
    expect(result!.id).toBe('a');
  });

  it('includes a gated node once its prereq is demonstrated', () => {
    const nodes = [
      makeNode({ id: 'a', name: 'A', missionRelevance: 0.9, mastery: 'demonstrated' }),
      makeNode({ id: 'b', name: 'B', missionRelevance: 0.8, mastery: 'not_started' }),
    ];
    const edges = [makeEdge('b', 'a')]; // b requires a (now demonstrated)
    const result = pickFrontierNode({ nodes, edges });
    // 'a' is mastered so excluded; 'b' prereqs satisfied → frontier = ['b']
    expect(result!.id).toBe('b');
  });

  it('includes a gated node once its prereq is mastered', () => {
    const nodes = [
      makeNode({ id: 'a', name: 'A', missionRelevance: 0.9, mastery: 'mastered' }),
      makeNode({ id: 'b', name: 'B', missionRelevance: 0.8, mastery: 'not_started' }),
    ];
    const edges = [makeEdge('b', 'a')];
    const result = pickFrontierNode({ nodes, edges });
    expect(result!.id).toBe('b');
  });
});

describe('pickFrontierNode — mission-relevance ordering', () => {
  it('returns the unmastered node with highest missionRelevance from the frontier', () => {
    const nodes = [
      makeNode({ id: 'x', name: 'X', missionRelevance: 0.4, mastery: 'not_started' }),
      makeNode({ id: 'y', name: 'Y', missionRelevance: 0.95, mastery: 'not_started' }),
      makeNode({ id: 'z', name: 'Z', missionRelevance: 0.6, mastery: 'not_started' }),
    ];
    const result = pickFrontierNode({ nodes, edges: [] });
    expect(result!.id).toBe('y');
  });
});

describe('pickFrontierNode — all mastered', () => {
  it('returns null when every node is mastered', () => {
    const nodes = [
      makeNode({ id: 'p', name: 'P', mastery: 'demonstrated' }),
      makeNode({ id: 'q', name: 'Q', mastery: 'mastered' }),
    ];
    const result = pickFrontierNode({ nodes, edges: [] });
    expect(result).toBeNull();
  });

  it('returns null when there are no nodes at all', () => {
    const result = pickFrontierNode({ nodes: [], edges: [] });
    expect(result).toBeNull();
  });
});

// ── buildOpenerItems ──────────────────────────────────────────────────────────

describe('buildOpenerItems', () => {
  const makeGlossaryTerm = (
    term: string,
    definition: string,
  ): TrackState['glossary'][number] => ({
    id: crypto.randomUUID(),
    trackId: 'track-1',
    term,
    definition,
    avoidAliases: [],
    cluster: null,
    ambiguityNote: null,
    promotionEvidenceRecordId: crypto.randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it('caps at 2 items by default when more glossary terms exist', () => {
    const glossary = [
      makeGlossaryTerm('variable', 'A named container for a value.'),
      makeGlossaryTerm('loop', 'A construct that repeats code.'),
      makeGlossaryTerm('function', 'A reusable block of code.'),
    ];
    const items = buildOpenerItems(glossary);
    expect(items).toHaveLength(2);
  });

  it('uses the term definition as the correct option (index 0)', () => {
    const glossary = [makeGlossaryTerm('variable', 'A named container for a value.')];
    const [item] = buildOpenerItems(glossary);
    expect(item.options[0]).toBe('A named container for a value.');
    expect(item.correctIndex).toBe(0);
  });

  it('includes the term in the question text', () => {
    const glossary = [makeGlossaryTerm('variable', 'A named container for a value.')];
    const [item] = buildOpenerItems(glossary);
    expect(item.question).toContain('variable');
  });

  it('uses the definition as the explanation', () => {
    const glossary = [makeGlossaryTerm('variable', 'A named container for a value.')];
    const [item] = buildOpenerItems(glossary);
    expect(item.explanation).toBe('A named container for a value.');
  });

  it('returns empty array for empty glossary', () => {
    const items = buildOpenerItems([]);
    expect(items).toHaveLength(0);
  });

  it('respects the max parameter', () => {
    const glossary = [
      makeGlossaryTerm('variable', 'A named container for a value.'),
      makeGlossaryTerm('loop', 'A construct that repeats code.'),
      makeGlossaryTerm('function', 'A reusable block of code.'),
    ];
    const items = buildOpenerItems(glossary, 1);
    expect(items).toHaveLength(1);
  });
});

// ── hydrateTrackState (integration) ──────────────────────────────────────────

describe('hydrateTrackState', () => {
  beforeAll(resetDb);
  afterAll(() => testPool.end());

  it('returns null for a missing track id', async () => {
    const result = await hydrateTrackState(testDb, crypto.randomUUID());
    expect(result).toBeNull();
  });

  it('returns null when track exists but has no mission', async () => {
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'H', email: `h-nomission-${crypto.randomUUID()}@t.dev` })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'H', ageBand: '18_plus' })
      .returning();
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId: learner.id, topic: 'Test Topic', vertical: 'programming' })
      .returning();
    // No mission inserted
    const result = await hydrateTrackState(testDb, track.id);
    expect(result).toBeNull();
  });

  it('round-trips: returns all seeded entities for a fully initialised track', async () => {
    // Seed user → learner → track → mission → learning_record → glossary term → nodes + edge
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'HT', email: `ht-${crypto.randomUUID()}@t.dev` })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'HT', ageBand: '18_plus' })
      .returning();
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId: learner.id, topic: 'Python CLI', vertical: 'programming' })
      .returning();
    const [mission] = await testDb
      .insert(s.missions)
      .values({ trackId: track.id, whyText: 'ship a CLI tool' })
      .returning();
    const [record] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id,
        seq: 1,
        recordType: 'prior_knowledge',
        title: 'Knows Python basics',
        body: 'Has some prior experience.',
      })
      .returning();
    await testDb.insert(s.glossaryTerms).values({
      trackId: track.id,
      term: 'variable',
      definition: 'A named container for a value.',
      promotionEvidenceRecordId: record.id,
    });
    const [nodeA] = await testDb
      .insert(s.skillNodes)
      .values({ trackId: track.id, name: 'Variables', missionRelevance: 0.9 })
      .returning();
    const [nodeB] = await testDb
      .insert(s.skillNodes)
      .values({ trackId: track.id, name: 'Functions', missionRelevance: 0.8 })
      .returning();
    await testDb.insert(s.skillNodeEdges).values({ nodeId: nodeB.id, prereqId: nodeA.id });

    const state = await hydrateTrackState(testDb, track.id);

    expect(state).not.toBeNull();
    expect(state!.track.id).toBe(track.id);
    expect(state!.mission.id).toBe(mission.id);
    expect(state!.records).toHaveLength(1);
    expect(state!.records[0].id).toBe(record.id);
    expect(state!.glossary).toHaveLength(1);
    expect(state!.glossary[0].term).toBe('variable');
    expect(state!.nodes).toHaveLength(2);
    expect(state!.edges).toHaveLength(1);
    expect(state!.edges[0].nodeId).toBe(nodeB.id);
    expect(state!.edges[0].prereqId).toBe(nodeA.id);
  });

  it('limits records to MAX_RECORDS_IN_CONTEXT (active only, ordered by seq descending)', async () => {
    // Seed a track with 2 active records + 1 superseded — only active records should appear,
    // capped at 30. We assert ordering (newest first) and active filter.
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'RL', email: `rl-${crypto.randomUUID()}@t.dev` })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'RL', ageBand: '18_plus' })
      .returning();
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId: learner.id, topic: 'Rust', vertical: 'programming' })
      .returning();
    await testDb.insert(s.missions).values({ trackId: track.id, whyText: 'learn Rust' });
    const [r1] = await testDb
      .insert(s.learningRecords)
      .values({ trackId: track.id, seq: 1, recordType: 'prior_knowledge', title: 'R1', body: 'b1' })
      .returning();
    await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id,
        seq: 2,
        recordType: 'prior_knowledge',
        title: 'R2',
        body: 'b2',
        status: 'superseded',
        supersededById: r1.id,
      });
    await testDb
      .insert(s.learningRecords)
      .values({ trackId: track.id, seq: 3, recordType: 'prior_knowledge', title: 'R3', body: 'b3' });

    const state = await hydrateTrackState(testDb, track.id);
    expect(state).not.toBeNull();
    // Only 2 active records (seq 1 and 3); seq 2 is superseded
    expect(state!.records).toHaveLength(2);
    expect(state!.records.every((r) => r.status === 'active')).toBe(true);
    // Ordered by seq descending (newest first)
    expect(state!.records[0].seq).toBe(3);
    expect(state!.records[1].seq).toBe(1);
  });
});

// ── planLesson (fake-mode fixture round-trip) ─────────────────────────────────

describe('planLesson — fake mode', () => {
  beforeEach(() => {
    process.env.AI_FAKE_LLM = '1';
  });

  it('returns a LessonPlan that parses against lessonPlanSchema in fake mode', async () => {
    // Build a minimal in-memory TrackState (no DB needed — planLesson is a pure LLM call)
    const now = new Date();
    const state: TrackState = {
      track: {
        id: 'track-1',
        learnerId: 'learner-1',
        topic: 'Python CLI tools',
        vertical: 'programming',
        status: 'active',
        expertiseBand: 'novice',
        communityOptOut: false,
        createdAt: now,
      },
      mission: {
        id: 'mission-1',
        trackId: 'track-1',
        whyText: 'ship a CLI tool',
        successCriteria: [{ description: 'CLI my team uses' }],
        constraints: {},
        outOfScope: [],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      records: [],
      glossary: [],
      nodes: [],
      edges: [],
      uploads: [],
    };
    const node = makeNode({ id: 'n1', name: 'Variables and types', summary: 'Declaring and using basic values', missionRelevance: 0.9 });

    const plan = await planLesson(state, node);

    // Must parse without errors
    const parsed = lessonPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
    // Fixture values from ai-fixtures.ts
    expect(plan.format).toBe('article');
    expect(plan.estimatedMinutes).toBe(8);
    expect(plan.objective).toBe('Declare and use variables to store values');
    expect(plan.blockOutline).toHaveLength(4);
  });
});
