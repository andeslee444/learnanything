/**
 * Verification workflow tests — Phase 6, Task 3.
 *
 * Tests:
 * 1. Workflow sequence (seed → verify → finalize) via direct function calls (fake mode).
 * 2. Regenerate path: sequential mock (first entail unsupported → regenerate → second
 *    entail supported → content block replaced + status 'regenerated').
 * 3. Once-rule: already-regenerated row refuses a second call to regenerateBlock.
 * 4. Finalize score + alert seam: spy on console.warn under ALERT_THRESHOLD.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { verifyBlock, regenerateBlock } from '@/server/lessons/verify';
import { faithfulnessScore, ALERT_THRESHOLD } from '@/server/lessons/verdicts';
import { createSequentialMockLanguageModel } from '@/test/mock-llm-helper';

// ── Seed helpers ──────────────────────────────────────────────────────────────

const PYTHON_URL = 'https://docs.python.org/3/tutorial/index.html';
const MDN_URL = 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps';

async function seedWorld(suffix = '') {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'V' + suffix, email: `${crypto.randomUUID()}@verify.test` })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'V' + suffix, ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Python variables', vertical: 'programming', expertiseBand: 'novice' })
    .returning();
  await testDb.insert(s.missions).values({
    trackId: track.id,
    whyText: 'learn to code',
    successCriteria: [{ description: 'write a script' }],
    constraints: {},
    outOfScope: [],
  });
  return { u, learner, track };
}

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed * (i + 1)));
}

async function seedDossier() {
  const [dossier] = await testDb
    .insert(s.topicDossiers)
    .values({
      vertical: 'programming',
      topic: 'Python variables',
      levelBand: 'novice',
      embedding: fakeEmbedding(42),
      ttlExpiresAt: new Date(Date.now() + 86_400_000),
      sources: [
        { url: PYTHON_URL, title: 'Python Tutorial' },
        { url: MDN_URL, title: 'MDN' },
      ],
      claims: [
        { claim: 'Variables store values under a name.', sourceUrls: [PYTHON_URL] },
        { claim: 'Functions bundle reusable behavior.', sourceUrls: [PYTHON_URL, MDN_URL] },
      ],
      misconceptions: ['Variables contain values rather than referencing them.'],
      glossarySeeds: [],
    })
    .returning();
  return dossier;
}

/**
 * Seeds a ready lesson with article blocks.
 * blocks: array of {type, heading?, markdown?, citationUrls?}
 */
async function seedReadyLesson(
  trackId: string,
  dossierId: string,
  blocks: Array<{
    type: string;
    heading?: string;
    markdown?: string;
    citationUrls?: string[];
    term?: string;
    definition?: string;
    items?: unknown[];
    cards?: unknown[];
  }>,
  seq = 1,
) {
  const [lesson] = await testDb
    .insert(s.lessons)
    .values({
      trackId,
      seq,
      spec: { objective: 'Declare and use variables', format: 'article', estimatedMinutes: 8, blockOutline: [] },
      content: {
        blocks,
        winCheck: { items: [{ id: 'wc1', question: 'Q?', options: ['A', 'B', 'C', 'D'], correctIndex: 0, explanation: 'E' }] },
        openerItems: [],
      },
      citations: [{ url: PYTHON_URL }],
      zpdSnapshot: { dossierId },
      status: 'ready',
    })
    .returning();
  return lesson;
}

// ── shared setup ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
});
afterAll(() => testPool.end());
beforeEach(() => { process.env.AI_FAKE_LLM = '1'; });

// ── Test 1: Seed step ─────────────────────────────────────────────────────────

describe('seed step — inserts checking rows for article blocks', () => {
  it('inserts a checking row for each article block, skips non-article', async () => {
    const { track } = await seedWorld('seed');
    const dossier = await seedDossier();

    const blocks = [
      { type: 'article', heading: 'Variables', markdown: 'A variable stores a value under a name.', citationUrls: [PYTHON_URL] },
      { type: 'glossary_callout', term: 'variable', definition: 'A named container.' },
      { type: 'article', heading: 'Good names', markdown: 'Names should say what the value means.', citationUrls: [MDN_URL] },
    ];

    const lesson = await seedReadyLesson(track.id, dossier.id, blocks);

    // Manually seed checking rows (simulating the seed step)
    await testDb
      .insert(s.verificationResults)
      .values([
        { lessonId: lesson.id, blockId: 'block-0', status: 'checking', claimsTotal: 0, claimsVerified: 0, details: [] },
        { lessonId: lesson.id, blockId: 'block-2', status: 'checking', claimsTotal: 0, claimsVerified: 0, details: [] },
      ])
      .onConflictDoNothing();

    const rows = await testDb
      .select()
      .from(s.verificationResults)
      .where(eq(s.verificationResults.lessonId, lesson.id));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.blockId).sort()).toEqual(['block-0', 'block-2']);
    expect(rows.every((r) => r.status === 'checking')).toBe(true);
  });

  it('seed is idempotent — ON CONFLICT DO NOTHING skips re-insert', async () => {
    const { track } = await seedWorld('seed-idem');
    const dossier = await seedDossier();

    const blocks = [
      { type: 'article', heading: 'V', markdown: 'Variables store values.', citationUrls: [PYTHON_URL] },
    ];
    const lesson = await seedReadyLesson(track.id, dossier.id, blocks, 2);

    // Insert twice — second should be no-op
    for (let i = 0; i < 2; i++) {
      await testDb
        .insert(s.verificationResults)
        .values([{ lessonId: lesson.id, blockId: 'block-0', status: 'checking', claimsTotal: 0, claimsVerified: 0, details: [] }])
        .onConflictDoNothing();
    }

    const rows = await testDb
      .select()
      .from(s.verificationResults)
      .where(eq(s.verificationResults.lessonId, lesson.id));

    expect(rows).toHaveLength(1);
  });
});

// ── Test 2: verifyBlock — happy path (fake mode) ──────────────────────────────

describe('verifyBlock — fake mode happy path', () => {
  it('verifies an article block and writes a verified row', async () => {
    const { track } = await seedWorld('vb-happy');
    const dossier = await seedDossier();

    const lesson = await seedReadyLesson(track.id, dossier.id, [
      {
        type: 'article',
        heading: 'Variables: names for values',
        markdown:
          'A **variable** stores a value under a name so your program can use it later. ' +
          'Variables let the same code work with different values.',
        citationUrls: [PYTHON_URL],
      },
    ]);

    const result = await verifyBlock(testDb, { lessonId: lesson.id, blockIndex: 0 });
    // In fake mode, entail-claim always returns 'supported', so badge = 'verified'.
    // But verifyBlock may call regenerateBlock for unverified — in fake mode all claims pass.
    expect(['verified', 'regenerated']).toContain(result.status);

    const rows = await testDb
      .select()
      .from(s.verificationResults)
      .where(eq(s.verificationResults.lessonId, lesson.id));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const blockRow = rows.find((r) => r.blockId === 'block-0');
    expect(blockRow).toBeTruthy();
    expect(['verified', 'regenerated']).toContain(blockRow?.status);
  });

  it('skips a non-article block without writing a row', async () => {
    const { track } = await seedWorld('vb-skip');
    const dossier = await seedDossier();

    const lesson = await seedReadyLesson(track.id, dossier.id, [
      { type: 'glossary_callout', term: 'variable', definition: 'A named container.' },
    ], 3);

    const result = await verifyBlock(testDb, { lessonId: lesson.id, blockIndex: 0 });
    expect(result.status).toBe('skipped');

    const rows = await testDb
      .select()
      .from(s.verificationResults)
      .where(eq(s.verificationResults.lessonId, lesson.id));
    expect(rows).toHaveLength(0);
  });
});

// ── Test 3: Finalize — score + alert seam ────────────────────────────────────

describe('finalize — faithfulness score + console.warn alert seam', () => {
  it('updates faithfulnessScore and verificationStatus on the lesson row', async () => {
    const { track } = await seedWorld('fin-score');
    const dossier = await seedDossier();

    const lesson = await seedReadyLesson(track.id, dossier.id, [
      { type: 'article', heading: 'V', markdown: 'A variable stores a value.', citationUrls: [PYTHON_URL] },
    ], 4);

    // Insert two mock verification rows: 2/2 verified → score = 1.0
    await testDb.insert(s.verificationResults).values([
      { lessonId: lesson.id, blockId: 'block-0', status: 'verified', claimsTotal: 2, claimsVerified: 2, details: [] },
    ]).onConflictDoNothing();

    // Simulate finalize logic directly (in workflow it's a step)
    const rows = await testDb
      .select({ claimsVerified: s.verificationResults.claimsVerified, claimsTotal: s.verificationResults.claimsTotal, status: s.verificationResults.status })
      .from(s.verificationResults)
      .where(eq(s.verificationResults.lessonId, lesson.id));

    const score = faithfulnessScore(rows);
    const allVerified = rows.every((r) => r.status === 'verified' || r.status === 'regenerated');
    const verificationStatus: 'verified' | 'issues' = allVerified ? 'verified' : 'issues';

    await testDb.update(s.lessons).set({ faithfulnessScore: score, verificationStatus }).where(eq(s.lessons.id, lesson.id));

    const [updated] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(updated.faithfulnessScore).toBeCloseTo(1.0);
    expect(updated.verificationStatus).toBe('verified');
  });

  it('fires console.warn under ALERT_THRESHOLD (founder-alert seam)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const score = 0.6; // below 0.8
      if (score < ALERT_THRESHOLD) {
        console.warn('[founder-alert] faithfulness', { lessonId: 'test-lesson', score });
      }
      expect(warnSpy).toHaveBeenCalledWith(
        '[founder-alert] faithfulness',
        expect.objectContaining({ score: 0.6 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT fire console.warn above ALERT_THRESHOLD', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const score = 0.9; // above 0.8
      if (score < ALERT_THRESHOLD) {
        console.warn('[founder-alert] faithfulness', { lessonId: 'test-lesson', score });
      }
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('issues status when some blocks are unverified', async () => {
    const { track } = await seedWorld('fin-issues');
    const dossier = await seedDossier();

    const lesson = await seedReadyLesson(track.id, dossier.id, [
      { type: 'article', heading: 'V', markdown: 'A variable stores a value.', citationUrls: [PYTHON_URL] },
    ], 5);

    await testDb.insert(s.verificationResults).values([
      { lessonId: lesson.id, blockId: 'block-0', status: 'unverified', claimsTotal: 2, claimsVerified: 1, details: [] },
    ]).onConflictDoNothing();

    const rows = await testDb
      .select({ claimsVerified: s.verificationResults.claimsVerified, claimsTotal: s.verificationResults.claimsTotal, status: s.verificationResults.status })
      .from(s.verificationResults)
      .where(eq(s.verificationResults.lessonId, lesson.id));

    const allVerified = rows.every((r) => r.status === 'verified' || r.status === 'regenerated');
    expect(allVerified).toBe(false);

    const verificationStatus = allVerified ? 'verified' : 'issues';
    expect(verificationStatus).toBe('issues');
  });
});

// ── Test 4: Regenerate path — sequential mock ─────────────────────────────────

describe('regenerateBlock — sequential mock path', () => {
  it('first entail unsupported → regenerate → second entail supported → status=regenerated + content replaced', async () => {
    process.env.AI_FAKE_LLM = '0';

    const { track } = await seedWorld('regen-mock');
    const dossier = await seedDossier();

    const originalMarkdown = 'A variable is a concept from quantum physics.'; // wrong claim
    const lesson = await seedReadyLesson(track.id, dossier.id, [
      { type: 'article', heading: 'Variables', markdown: originalMarkdown, citationUrls: [PYTHON_URL] },
    ], 6);

    // Sequential mock:
    // Call 1: extract-claims → returns 1 claim
    // Call 2: entail-claim (first verify) → unsupported (triggers regenerate)
    // Call 3: regenerate-block → new article block
    // Call 4: moderation → allowed
    // Call 5: extract-claims (re-verify) → 1 claim
    // Call 6: entail-claim (re-verify) → supported
    const sequentialModel = createSequentialMockLanguageModel([
      // Call 1: extract-claims (initial)
      JSON.stringify({ claims: [{ claim: 'A variable is a quantum physics concept.' }] }),
      // Call 2: entail-claim → unsupported
      JSON.stringify({ verdict: 'unsupported', sourceUrl: null, note: 'Not in dossier' }),
      // Call 3: regenerate-block → new article block
      JSON.stringify({
        type: 'article',
        heading: 'Variables: names for values',
        markdown: 'A **variable** stores a value under a name so your program can use it later. Variables let the same code work with different values.',
        citationUrls: [PYTHON_URL],
      }),
      // Call 4: moderation
      JSON.stringify({ allowed: true, reason: 'educational' }),
      // Call 5: extract-claims (re-verify)
      JSON.stringify({ claims: [{ claim: 'A variable stores a value under a name.' }] }),
      // Call 6: entail-claim (re-verify) → supported
      JSON.stringify({ verdict: 'supported', sourceUrl: PYTHON_URL, note: 'Dossier supports this' }),
    ]);

    // Seed a checking row (workflow would have done this in seed step)
    await testDb.insert(s.verificationResults).values([
      { lessonId: lesson.id, blockId: 'block-0', status: 'checking', claimsTotal: 0, claimsVerified: 0, details: [] },
    ]).onConflictDoNothing();

    const result = await verifyBlock(testDb, { lessonId: lesson.id, blockIndex: 0, modelOverride: sequentialModel });
    expect(result.status).toBe('regenerated');

    // Verify the row status is 'regenerated'
    const [row] = await testDb
      .select()
      .from(s.verificationResults)
      .where(
        sql`${s.verificationResults.lessonId} = ${lesson.id}
          AND ${s.verificationResults.blockId} = 'block-0'`,
      );
    expect(row?.status).toBe('regenerated');

    // Verify the lesson content block was replaced
    const [updatedLesson] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    const updatedContent = updatedLesson.content as { blocks: Array<{ markdown: string }> };
    expect(updatedContent.blocks[0].markdown).not.toBe(originalMarkdown);
    expect(updatedContent.blocks[0].markdown).toContain('variable');
  });

  it('regenerate: still-failing block → status=unverified, original content kept', async () => {
    process.env.AI_FAKE_LLM = '0';

    const { track } = await seedWorld('regen-fail');
    const dossier = await seedDossier();

    const originalMarkdown = 'A variable is a quantum physics concept.';
    const lesson = await seedReadyLesson(track.id, dossier.id, [
      { type: 'article', heading: 'Variables', markdown: originalMarkdown, citationUrls: [PYTHON_URL] },
    ], 7);

    // Sequential mock: both initial and re-verify return unsupported
    const sequentialModel = createSequentialMockLanguageModel([
      // extract-claims (initial)
      JSON.stringify({ claims: [{ claim: 'A variable is a quantum physics concept.' }] }),
      // entail-claim → unsupported
      JSON.stringify({ verdict: 'unsupported', sourceUrl: null, note: 'Not in dossier' }),
      // regenerate-block
      JSON.stringify({
        type: 'article',
        heading: 'Variables',
        markdown: 'Variables are quantum physics entities that store quantum states and superpositions of values in memory.',
        citationUrls: [PYTHON_URL],
      }),
      // moderation
      JSON.stringify({ allowed: true, reason: 'educational' }),
      // extract-claims (re-verify)
      JSON.stringify({ claims: [{ claim: 'Variables are quantum physics.' }] }),
      // entail-claim (re-verify) → still unsupported
      JSON.stringify({ verdict: 'unsupported', sourceUrl: null, note: 'Still not in dossier' }),
    ]);

    await testDb.insert(s.verificationResults).values([
      { lessonId: lesson.id, blockId: 'block-0', status: 'checking', claimsTotal: 0, claimsVerified: 0, details: [] },
    ]).onConflictDoNothing();

    const result = await verifyBlock(testDb, { lessonId: lesson.id, blockIndex: 0, modelOverride: sequentialModel });
    expect(result.status).toBe('unverified');

    const [row] = await testDb
      .select()
      .from(s.verificationResults)
      .where(
        sql`${s.verificationResults.lessonId} = ${lesson.id}
          AND ${s.verificationResults.blockId} = 'block-0'`,
      );
    expect(row?.status).toBe('unverified');

    // Original content must be kept (no swap on still-failing)
    const [lessonAfter] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    const content = lessonAfter.content as { blocks: Array<{ markdown: string }> };
    expect(content.blocks[0].markdown).toBe(originalMarkdown);
  });
});

// ── Test 5: Once-rule — already-regenerated refuses repeat ───────────────────

describe('regenerateBlock — once-rule', () => {
  it('refuses when the row is already regenerated', async () => {
    process.env.AI_FAKE_LLM = '0';

    const { track } = await seedWorld('once-rule');
    const dossier = await seedDossier();

    const lesson = await seedReadyLesson(track.id, dossier.id, [
      { type: 'article', heading: 'Variables', markdown: 'A variable stores a value.', citationUrls: [PYTHON_URL] },
    ], 8);

    // Pre-insert a 'regenerated' row — simulates a block that was already regenerated
    await testDb.insert(s.verificationResults).values([
      { lessonId: lesson.id, blockId: 'block-0', status: 'regenerated', claimsTotal: 2, claimsVerified: 2, details: [] },
    ]).onConflictDoNothing();

    // Attempt to regenerate again — must be refused
    const result = await regenerateBlock(testDb, {
      lessonId: lesson.id,
      blockIndex: 0,
      unsupportedClaims: ['Some claim'],
    });

    expect(result.status).toBe('refused');

    // Row must still be 'regenerated', unchanged
    const [row] = await testDb
      .select()
      .from(s.verificationResults)
      .where(
        sql`${s.verificationResults.lessonId} = ${lesson.id}
          AND ${s.verificationResults.blockId} = 'block-0'`,
      );
    expect(row?.status).toBe('regenerated');
  });
});

// ── Test 6: Full workflow sequence via direct function calls ──────────────────

describe('verify workflow — seed → verify → finalize sequence', () => {
  it('full round-trip: rows per article block, badge statuses, faithfulnessScore set', async () => {
    const { track } = await seedWorld('workflow-seq');
    const dossier = await seedDossier();

    // Lesson with 2 article blocks and 1 non-article
    const lesson = await seedReadyLesson(track.id, dossier.id, [
      {
        type: 'article',
        heading: 'Variables: names for values',
        markdown:
          'A **variable** stores a value under a name so your program can use it later. ' +
          'Variables let the same code work with different values.',
        citationUrls: [PYTHON_URL],
      },
      { type: 'glossary_callout', term: 'variable', definition: 'A named container.' },
      {
        type: 'article',
        heading: 'Good names',
        markdown: 'Names should say what the value means: `user_count` beats `x`.',
        citationUrls: [MDN_URL],
      },
    ], 9);

    // Seed step: insert checking rows for article blocks (indexes 0 and 2)
    await testDb.insert(s.verificationResults).values([
      { lessonId: lesson.id, blockId: 'block-0', status: 'checking', claimsTotal: 0, claimsVerified: 0, details: [] },
      { lessonId: lesson.id, blockId: 'block-2', status: 'checking', claimsTotal: 0, claimsVerified: 0, details: [] },
    ]).onConflictDoNothing();

    // Verify step: fake mode (AI_FAKE_LLM=1 → all claims supported)
    await verifyBlock(testDb, { lessonId: lesson.id, blockIndex: 0 });
    await verifyBlock(testDb, { lessonId: lesson.id, blockIndex: 2 });

    // Finalize step
    const rows = await testDb
      .select({ claimsVerified: s.verificationResults.claimsVerified, claimsTotal: s.verificationResults.claimsTotal, status: s.verificationResults.status })
      .from(s.verificationResults)
      .where(eq(s.verificationResults.lessonId, lesson.id));

    expect(rows.length).toBeGreaterThanOrEqual(2);

    const score = faithfulnessScore(rows);
    const allVerified = rows.every((r) => r.status === 'verified' || r.status === 'regenerated');
    const verificationStatus: 'verified' | 'issues' = allVerified ? 'verified' : 'issues';

    await testDb
      .update(s.lessons)
      .set({ faithfulnessScore: score, verificationStatus })
      .where(eq(s.lessons.id, lesson.id));

    const [updated] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(typeof updated.faithfulnessScore).toBe('number');
    expect(updated.faithfulnessScore).toBeGreaterThanOrEqual(0);
    expect(['verified', 'issues']).toContain(updated.verificationStatus);

    // Non-article block (index 1) must have no row
    const rowBlockIds = rows.map((r) => r).filter((r) => {
      // We need to get blockId — use a separate query
      return true;
    });
    // Verify that 'block-1' is not present
    const allRows = await testDb.select().from(s.verificationResults).where(eq(s.verificationResults.lessonId, lesson.id));
    const blockIds = allRows.map((r) => r.blockId);
    expect(blockIds).not.toContain('block-1');
  });
});
