/**
 * Integration tests for the lesson pipeline (Task 5, Phase 4a).
 * All tests use AI_FAKE_LLM=1 — no real model calls.
 * The workflow wrapper is NOT tested here (it calls stages by lessonId,
 * identical to what we call directly; e2e covers the full workflow).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { placeHold } from '@/lib/credits';
import { createLessonRow, stagePlan, stageGenerate, stageResearch, recordWinCheckResult } from '@/server/lessons/pipeline';
import { lessonContentSchema } from '@/server/lessons/blocks';
import { winCheckPassed } from '@/server/lessons/blocks';

// ── helpers ──────────────────────────────────────────────────────────────────

async function seedAllowlist(vertical: string, domains: string[]) {
  await testDb.insert(s.trustDomains).values(
    domains.map((domain) => ({ vertical, domain, tier: 'tier1' as const, note: 'test' })),
  );
}

/**
 * Seeds: user → learner → track (with mission + skill nodes).
 * Returns { userId, learnerId, trackId, nodeId }.
 */
async function seedFullTrack(email: string) {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'T', email })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'T', ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Python variables', vertical: 'programming', expertiseBand: 'novice' })
    .returning();
  await testDb.insert(s.missions).values({
    trackId: track.id,
    whyText: 'learn to program',
    successCriteria: [{ description: 'write a working script' }],
    constraints: {},
    outOfScope: [],
  });
  const [node] = await testDb
    .insert(s.skillNodes)
    .values({ trackId: track.id, name: 'Variables and types', summary: 'Declaring and using basic values', missionRelevance: 0.9 })
    .returning();
  // Seed a learning record to serve as promotionEvidenceRecordId for the glossary term.
  const [record] = await testDb
    .insert(s.learningRecords)
    .values({
      trackId: track.id,
      seq: 1,
      recordType: 'prior_knowledge',
      title: 'Prior knowledge',
      body: 'Some prior knowledge.',
      evidence: {},
    })
    .returning();
  // Seed a glossary term so openerItems appear in the delivered lesson.
  await testDb.insert(s.glossaryTerms).values({
    trackId: track.id,
    term: 'variable',
    definition: 'A named container for a value.',
    promotionEvidenceRecordId: record.id,
  });
  return { userId: u.id, learnerId: learner.id, trackId: track.id, nodeId: node.id };
}

// ── shared env ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
  await seedAllowlist('programming', ['docs.python.org', 'developer.mozilla.org', 'realpython.com']);
});
afterAll(() => testPool.end());
beforeEach(() => { process.env.AI_FAKE_LLM = '1'; });

// ── Test 1: Full pipeline happy path ─────────────────────────────────────────

describe('full pipeline — happy path', () => {
  it('delivers a ready lesson with content, openerItems, and a captured credit', async () => {
    const { userId, trackId } = await seedFullTrack('pipeline-happy@t.dev');

    // Ensure the user has credits (grant once).
    await testDb.insert(s.creditLedger).values({ userId, entryType: 'grant', amount: 3 });

    const lesson = await createLessonRow(testDb, trackId);
    expect(lesson.status).toBe('generating');
    expect(lesson.seq).toBe(1);

    // Place a hold before the pipeline runs.
    const holdId = await placeHold(testDb, userId, lesson.id);
    expect(holdId).toBeTruthy();

    // Stage 1: plan.
    const planResult = await stagePlan(testDb, lesson.id);
    expect(planResult.status).toBe('planned');

    // Stage 2: research.
    const researchResult = await stageResearch(testDb, lesson.id);
    expect(researchResult.status).toBe('researched');

    // Stage 3: generate + deliver.
    const generateResult = await stageGenerate(testDb, lesson.id);
    expect(generateResult.status).toBe('ready');

    // Lesson is now ready.
    const [delivered] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(delivered.status).toBe('ready');

    // Content parses against lessonContentSchema.
    const contentParse = lessonContentSchema.safeParse(delivered.content);
    expect(contentParse.success).toBe(true);

    // openerItems present (glossary term was seeded).
    const raw = delivered.content as Record<string, unknown>;
    expect(Array.isArray(raw.openerItems)).toBe(true);
    expect((raw.openerItems as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Citations carry urls.
    const citations = delivered.citations as Array<{ url: string }>;
    expect(Array.isArray(citations)).toBe(true);
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0].url).toBeTruthy();

    // Hold was CAPTURED: ledger has a capture row for this lesson.
    const ledger = await testDb
      .select()
      .from(s.creditLedger)
      .where(and(eq(s.creditLedger.lessonId, lesson.id), eq(s.creditLedger.entryType, 'capture')));
    expect(ledger.length).toBe(1);
    expect(ledger[0].amount).toBe(0); // capture row amount is 0
  });
});

// ── Test 2: Refund path (stagePlan fails — zero frontier nodes) ───────────────

describe('pipeline — failLesson refunds the hold', () => {
  it('refunds the credit hold when stagePlan finds no frontier skill', async () => {
    // Create a track with NO skill nodes (forcing "no frontier").
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'R', email: 'pipeline-refund@t.dev' })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'R', ageBand: '18_plus' })
      .returning();
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId: learner.id, topic: 'Empty topic', vertical: 'programming' })
      .returning();
    // Mission required by hydrateTrackState
    await testDb.insert(s.missions).values({
      trackId: track.id,
      whyText: 'learn things',
      successCriteria: [{ description: 'ok' }],
      constraints: {},
      outOfScope: [],
    });
    // NO skill nodes inserted — frontier will be null.

    // Grant + hold.
    await testDb.insert(s.creditLedger).values({ userId: u.id, entryType: 'grant', amount: 3 });
    const lesson = await createLessonRow(testDb, track.id);
    const holdId = await placeHold(testDb, u.id, lesson.id);
    expect(holdId).toBeTruthy();

    // stagePlan should fail with "no frontier skill".
    const result = await stagePlan(testDb, lesson.id);
    expect(result.status).toBe('failed');
    expect((result as { reason: string }).reason).toMatch(/frontier/);

    // Lesson status is failed.
    const [failed] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(failed.status).toBe('failed');

    // Hold was REFUNDED.
    const refunds = await testDb
      .select()
      .from(s.creditLedger)
      .where(and(eq(s.creditLedger.lessonId, lesson.id), eq(s.creditLedger.entryType, 'refund')));
    expect(refunds.length).toBe(1);
    expect(refunds[0].amount).toBe(1);
  });
});

// ── Test 3: Win-check recordWinCheckResult ────────────────────────────────────

describe('recordWinCheckResult', () => {
  let lessonId: string;
  let nodeId: string;

  beforeAll(async () => {
    // Seed minimal track for win-check tests.
    const { trackId, nodeId: nId } = await seedFullTrack('win-check@t.dev');
    nodeId = nId;
    const lesson = await createLessonRow(testDb, trackId);
    // Need spec set for the nodeId to be in the snapshot.
    await testDb
      .update(s.lessons)
      .set({ zpdSnapshot: { nodeId: nId, nodeName: 'Variables and types', expertiseBand: 'novice' } })
      .where(eq(s.lessons.id, lesson.id));
    lessonId = lesson.id;
  });

  it('passes 2/2 and marks node demonstrated', async () => {
    const result = await recordWinCheckResult(testDb, lessonId, 2, 2);
    expect(result.passed).toBe(true);
    const [node] = await testDb.select().from(s.skillNodes).where(eq(s.skillNodes.id, nodeId));
    expect(node.mastery).toBe('demonstrated');
  });

  it('fails 1/2 and leaves mastery unchanged', async () => {
    // Reset mastery for this check.
    await testDb.update(s.skillNodes).set({ mastery: 'not_started' }).where(eq(s.skillNodes.id, nodeId));
    const result = await recordWinCheckResult(testDb, lessonId, 1, 2);
    expect(result.passed).toBe(false);
    const [node] = await testDb.select().from(s.skillNodes).where(eq(s.skillNodes.id, nodeId));
    expect(node.mastery).toBe('not_started');
  });
});

// ── Test 4: Seq — two lessons get 1, 2 ───────────────────────────────────────

describe('createLessonRow — seq', () => {
  it('two lessons on one track get seq 1 and 2', async () => {
    const { trackId } = await seedFullTrack('seq-test@t.dev');
    const l1 = await createLessonRow(testDb, trackId);
    const l2 = await createLessonRow(testDb, trackId);
    expect(l1.seq).toBe(1);
    expect(l2.seq).toBe(2);
  });
});

// ── Test 5: winCheckPassed boundary tests ─────────────────────────────────────
// These tests live here per the review amendment ("in the pipeline test file or blocks-adjacent").

describe('winCheckPassed boundary tests', () => {
  // n=2: ceil(0.85*2)=2 → need 2
  it('n=2: 2/2 passes', () => { expect(winCheckPassed(2, 2)).toBe(true); });
  it('n=2: 1/2 fails', () => { expect(winCheckPassed(1, 2)).toBe(false); });

  // n=3: ceil(0.85*3)=ceil(2.55)=3 → need 3
  it('n=3: 3/3 passes', () => { expect(winCheckPassed(3, 3)).toBe(true); });
  it('n=3: 2/3 fails', () => { expect(winCheckPassed(2, 3)).toBe(false); });

  // n=4: ceil(0.85*4)=ceil(3.4)=4 → need 4
  it('n=4: 4/4 passes', () => { expect(winCheckPassed(4, 4)).toBe(true); });
  it('n=4: 3/4 fails', () => { expect(winCheckPassed(3, 4)).toBe(false); });
});

// ── Test 6: generateBlocks end-to-end with MockLanguageModelV3 + correction ────
// Satisfies the review amendment closing the T4 gap.

describe('generateBlocks end-to-end with mock model + correction', () => {
  it('captures the correction phrase in the prompt', async () => {
    const { MockLanguageModelV3 } = await import('ai/test');
    const { fakeOutputs } = await import('@/lib/ai-fixtures');
    const { generateBlocks } = await import('@/server/lessons/generate');
    const { lessonPlanSchema, lessonContentSchema } = await import('@/server/lessons/blocks');

    let capturedPrompt = '';
    const mock = new MockLanguageModelV3({
      doGenerate: async (input) => {
        const userMsg = (input.prompt as Array<{ role: string; content: Array<{ type: string; text: string }> }>)
          .find((m) => m.role === 'user');
        capturedPrompt = userMsg?.content.find((c) => c.type === 'text')?.text ?? '';
        return {
          content: [{ type: 'text', text: JSON.stringify(fakeOutputs['generate-lesson']) }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const plan = lessonPlanSchema.parse(fakeOutputs['plan-lesson']);
    const dossier = {
      sources: [
        { url: 'https://docs.python.org/3/tutorial/index.html', title: 'Python Tutorial' },
        { url: 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps', title: 'MDN' },
      ],
      claims: [{ claim: 'Variables store values under a name.', sourceUrls: ['https://docs.python.org/3/tutorial/index.html'] }],
      misconceptions: ['Variables contain values rather than referencing them.'],
    };
    const correctionMessage = 'no article block; duplicate quiz item ids';

    const result = await generateBlocks(plan, dossier, 'novice', correctionMessage, { modelOverride: mock });

    // The result must parse against lessonContentSchema.
    const parsed = lessonContentSchema.safeParse(result);
    expect(parsed.success).toBe(true);

    // The captured prompt must contain the correction phrase.
    expect(capturedPrompt).toContain('Your previous attempt failed validation:');
    expect(capturedPrompt).toContain(correctionMessage);
    expect(capturedPrompt).toContain('Fix every issue.');
  });
});
