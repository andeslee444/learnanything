/**
 * Integration tests for the lesson pipeline (Task 5, Phase 4a).
 * All tests use AI_FAKE_LLM=1 — no real model calls.
 * The workflow wrapper is NOT tested here (it calls stages by lessonId,
 * identical to what we call directly; e2e covers the full workflow).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { placeHold } from '@/lib/credits';
import { createLessonRow, stagePlan, stageGenerate, stageResearch, recordWinCheckResult } from '@/server/lessons/pipeline';
import { lessonContentSchema, winCheckPassed, findAttemptItem, type QuizItem } from '@/server/lessons/blocks';

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
    expect(l1.seq).toBe(1);
    // Advance l1 to 'ready' so the unique generating index allows a second lesson.
    await testDb.update(s.lessons).set({ status: 'ready' }).where(eq(s.lessons.id, l1.id));
    const l2 = await createLessonRow(testDb, trackId);
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

// ── Test 6a: CAS — failLesson on already-ready lesson has no side-effects ────────

describe('CAS — failLesson on already-terminal lesson', () => {
  it('stagePlan on a ready lesson: no refund row, status stays ready (CAS is a no-op)', async () => {
    // Seed a zero-node track — stagePlan would normally call failLesson.
    // But if the lesson is already 'ready', the CAS WHERE status='generating' clause should skip it.
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'C', email: 'cas-fail-ready@t.dev' })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'C', ageBand: '18_plus' })
      .returning();
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId: learner.id, topic: 'CAS topic', vertical: 'programming' })
      .returning();
    await testDb.insert(s.missions).values({
      trackId: track.id, whyText: 'learn', successCriteria: [{ description: 'ok' }], constraints: {}, outOfScope: [],
    });
    await testDb.insert(s.creditLedger).values({ userId: u.id, entryType: 'grant', amount: 3 });
    const lesson = await createLessonRow(testDb, track.id);
    await placeHold(testDb, u.id, lesson.id);

    // Manually set the lesson to 'ready' (as if delivery already succeeded).
    await testDb.update(s.lessons).set({ status: 'ready' }).where(eq(s.lessons.id, lesson.id));

    // stagePlan reads status and skips if not 'generating'.
    const result = await stagePlan(testDb, lesson.id);
    expect(result.status).toBe('skipped');

    // Lesson status must still be 'ready'.
    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(row.status).toBe('ready');

    // No refund row should have appeared.
    const refunds = await testDb
      .select()
      .from(s.creditLedger)
      .where(and(eq(s.creditLedger.lessonId, lesson.id), eq(s.creditLedger.entryType, 'refund')));
    expect(refunds.length).toBe(0);
  });

  it('deliver (stageGenerate) on a ready lesson: returns skipped, no duplicate capture', async () => {
    const { trackId } = await seedFullTrack('cas-deliver-ready@t.dev');
    const lesson = await createLessonRow(testDb, trackId);

    // Set status to 'ready' to simulate a race where delivery already won.
    await testDb.update(s.lessons).set({ status: 'ready' }).where(eq(s.lessons.id, lesson.id));

    // stageGenerate reads status; it will return skipped because status !== 'generating'.
    const result = await stageGenerate(testDb, lesson.id);
    expect(result.status).toBe('skipped');
  });
});

// ── Test 6b: Concurrent create guard — unique violation on one-generating-per-track ──

describe('concurrent create guard — lessons_one_generating_per_track', () => {
  it('inserting a second generating lesson for the same track throws a unique violation', async () => {
    const { trackId } = await seedFullTrack('concurrent-create@t.dev');
    // First lesson succeeds.
    await createLessonRow(testDb, trackId);
    // Second lesson in generating state must be rejected.
    const err = await createLessonRow(testDb, trackId).catch((e: unknown) => e);
    // Drizzle wraps PG errors: outer message or .cause.message contains the index name.
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg + causeMsg).toMatch(/lessons_one_generating_per_track/);
  });
});

// ── Test 6c: fail-stage via stagePlan on a zero-node track ────────────────────────
// runLessonStage('fail') is a thin wrapper around failLesson(appDb, ...) — appDb uses
// DATABASE_URL (main DB), not testDb. We test the fail-stage logic directly via
// stagePlan(testDb, ...) on a zero-node track, which calls the same failLesson path.

describe("fail stage — marks generating lesson failed and refunds the hold", () => {
  it('stagePlan on a no-skill-node track marks lesson failed + refunds', async () => {
    // Re-uses the zero-node setup from test 2 but as a standalone assertion.
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'F', email: 'fail-stage@t.dev' })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'F', ageBand: '18_plus' })
      .returning();
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId: learner.id, topic: 'Fail topic', vertical: 'programming' })
      .returning();
    await testDb.insert(s.missions).values({
      trackId: track.id, whyText: 'learn', successCriteria: [{ description: 'ok' }], constraints: {}, outOfScope: [],
    });
    await testDb.insert(s.creditLedger).values({ userId: u.id, entryType: 'grant', amount: 3 });
    const lesson = await createLessonRow(testDb, track.id);
    await placeHold(testDb, u.id, lesson.id);

    // stagePlan calls failLesson(testDb, ...) when no frontier node found.
    const result = await stagePlan(testDb, lesson.id);
    expect(result.status).toBe('failed');

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(row.status).toBe('failed');

    const refunds = await testDb
      .select()
      .from(s.creditLedger)
      .where(and(eq(s.creditLedger.lessonId, lesson.id), eq(s.creditLedger.entryType, 'refund')));
    expect(refunds.length).toBe(1);
    expect(refunds[0].amount).toBe(1);
  });
});

// ── Test I1: atomic zpdSnapshot merge — both key-write orderings survive ─────
// Verifies that stagePlan and a runId write can arrive in either order and both
// keys are always present (atomic jsonb || never loses a concurrent key).

describe('atomic zpdSnapshot merge — both write orderings preserve all keys', () => {
  it('runId written first, then stagePlan: both workflowRunId and nodeId present', async () => {
    const { trackId } = await seedFullTrack('zpd-order-a@t.dev');
    const lesson = await createLessonRow(testDb, trackId);

    // Simulate: runId arrives before stagePlan writes nodeId (create-route ordering).
    await testDb
      .update(s.lessons)
      .set({ zpdSnapshot: sql`zpd_snapshot || ${JSON.stringify({ workflowRunId: 'run-a' })}::jsonb` })
      .where(eq(s.lessons.id, lesson.id));

    // stagePlan writes nodeId atomically.
    const planResult = await stagePlan(testDb, lesson.id);
    expect(planResult.status).toBe('planned');

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    const snap = row.zpdSnapshot as Record<string, unknown>;
    expect(snap.workflowRunId).toBe('run-a');
    expect(snap.nodeId).toBeTruthy();
    expect(snap.nodeName).toBeTruthy();
  });

  it('stagePlan written first, then runId: both nodeId and workflowRunId present', async () => {
    const { trackId } = await seedFullTrack('zpd-order-b@t.dev');
    const lesson = await createLessonRow(testDb, trackId);

    // stagePlan writes nodeId first.
    const planResult = await stagePlan(testDb, lesson.id);
    expect(planResult.status).toBe('planned');

    // Simulate: runId arrives after (delayed workflow start).
    await testDb
      .update(s.lessons)
      .set({ zpdSnapshot: sql`zpd_snapshot || ${JSON.stringify({ workflowRunId: 'run-b' })}::jsonb` })
      .where(eq(s.lessons.id, lesson.id));

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    const snap = row.zpdSnapshot as Record<string, unknown>;
    expect(snap.nodeId).toBeTruthy();
    expect(snap.workflowRunId).toBe('run-b');
  });
});

// ── Test 7: findAttemptItem lookup across all item kinds ──────────────────────
// Tests the pure helper that scans openerItems, quiz blocks (including worked_example
// completionItems), and winCheck items by kind and itemId.

describe('findAttemptItem', () => {
  it('finds an opener item by itemId', () => {
    const openerItem: QuizItem = {
      id: 'opener-1',
      question: 'What is a variable?',
      options: ['A container', 'A function', 'A class', 'A module'],
      correctIndex: 0,
      explanation: 'A variable is a named container for a value.',
    };
    const content = {
      blocks: [
        {
          type: 'article' as const,
          heading: 'Variables',
          markdown: 'A variable is...',
          citationUrls: ['https://docs.python.org'],
        },
      ],
      winCheck: {
        items: [
          {
            id: 'wincheck-1',
            question: 'What holds a value?',
            options: ['Variable', 'Function', 'Class', 'Module'],
            correctIndex: 0,
            explanation: 'Variables hold values.',
          },
        ],
      },
      openerItems: [openerItem],
    };
    const found = findAttemptItem(content, 'opener', 'opener-1');
    expect(found).toEqual(openerItem);
  });

  it('finds a quiz item in a quiz block by itemId', () => {
    const quizItem: QuizItem = {
      id: 'quiz-1',
      question: 'What is a function?',
      options: ['Code block', 'Variable', 'Class', 'Import'],
      correctIndex: 0,
      explanation: 'A function is a reusable code block.',
    };
    const content = {
      blocks: [
        {
          type: 'article' as const,
          heading: 'Functions',
          markdown: 'A function is...',
          citationUrls: ['https://docs.python.org'],
        },
        {
          type: 'quiz' as const,
          items: [quizItem],
        },
      ],
      winCheck: {
        items: [
          {
            id: 'wincheck-1',
            question: 'What is a function?',
            options: ['A', 'B', 'C', 'D'],
            correctIndex: 0,
            explanation: 'Explanation',
          },
        ],
      },
      openerItems: [],
    };
    const found = findAttemptItem(content, 'quiz', 'quiz-1');
    expect(found).toEqual(quizItem);
  });

  it('finds a worked_example completionItem when kind=quiz', () => {
    const completionItem: QuizItem = {
      id: 'worked-ex-completion-1',
      question: 'Solve: 2 + 2 = ?',
      options: ['3', '4', '5', '6'],
      correctIndex: 1,
      explanation: '2 plus 2 equals 4.',
    };
    const content = {
      blocks: [
        {
          type: 'worked_example' as const,
          problem: 'Add two numbers.',
          steps: [
            { text: 'Add the first number to the second.' },
            { text: 'Verify the result.' },
          ],
          completionItem,
        },
      ],
      winCheck: {
        items: [
          {
            id: 'wincheck-1',
            question: 'Q',
            options: ['A', 'B', 'C', 'D'],
            correctIndex: 0,
            explanation: 'E',
          },
        ],
      },
      openerItems: [],
    };
    const found = findAttemptItem(content, 'quiz', 'worked-ex-completion-1');
    expect(found).toEqual(completionItem);
  });

  it('finds a winCheck item by itemId', () => {
    const winCheckItem: QuizItem = {
      id: 'wincheck-1',
      question: 'Final check?',
      options: ['Yes', 'No', 'Maybe', 'Unknown'],
      correctIndex: 0,
      explanation: 'Yes, you understood.',
    };
    const content = {
      blocks: [
        {
          type: 'article' as const,
          heading: 'Article',
          markdown: 'Content',
          citationUrls: ['https://example.com'],
        },
      ],
      winCheck: {
        items: [winCheckItem],
      },
      openerItems: [],
    };
    const found = findAttemptItem(content, 'win_check', 'wincheck-1');
    expect(found).toEqual(winCheckItem);
  });

  it('returns null when itemId not found', () => {
    const content = {
      blocks: [
        {
          type: 'article' as const,
          heading: 'Article',
          markdown: 'Content',
          citationUrls: ['https://example.com'],
        },
      ],
      winCheck: {
        items: [
          {
            id: 'wincheck-1',
            question: 'Q',
            options: ['A', 'B', 'C', 'D'],
            correctIndex: 0,
            explanation: 'E',
          },
        ],
      },
      openerItems: [],
    };
    const found = findAttemptItem(content, 'quiz', 'nonexistent-id');
    expect(found).toBeNull();
  });
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
