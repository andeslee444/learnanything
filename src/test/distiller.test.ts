/**
 * Distiller tests — Phase 5b.
 *
 * Tests:
 * 1. Full distill round-trip (fake mode): records inserted w/ correct seq + evidence;
 *    term promoted w/ FK; review card created; node mastery demonstrated; idempotent second run.
 * 2. Dedup paths: existing term not re-promoted; duplicate title dropped.
 * 3. Umbrella-record path: LLM returns promotions-only → umbrella record created first.
 * 4. First-attempt-only win-check tally: wrong-then-right ≠ pass.
 * 5. Reference docs (step 7): created on distill; same-title updates not duplicates;
 *    linkedLessonIds appends; idempotent second call skips ref-doc creation.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { distillLesson } from '@/server/lessons/distiller';
import { winCheckPassed } from '@/server/lessons/blocks';

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedWorld(suffix = '') {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'D' + suffix, email: `${crypto.randomUUID()}@distill.test` })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'D' + suffix, ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Python basics', vertical: 'programming' })
    .returning();
  await testDb.insert(s.missions).values({
    trackId: track.id,
    whyText: 'learn to code',
    successCriteria: [{ description: 'write a script' }],
    constraints: {},
    outOfScope: [],
  });
  const [node] = await testDb
    .insert(s.skillNodes)
    .values({
      trackId: track.id,
      name: 'Variables and types',
      summary: 'Declaring and using basic values',
      missionRelevance: 0.9,
    })
    .returning();

  return { u, learner, track, node };
}

async function seedReadyLesson(trackId: string, nodeId: string, seq = 1) {
  const [lesson] = await testDb
    .insert(s.lessons)
    .values({
      trackId,
      seq,
      spec: { objective: 'Declare and use variables to store values', nodeId },
      content: {
        blocks: [],
        winCheck: {
          items: [
            { id: 'wc1', question: 'What does a variable do?', options: ['Stores a value', 'Draws', 'Connects', 'Compiles'], correctIndex: 0, explanation: 'A variable stores a value.' },
            { id: 'wc2', question: 'After x=5 then x=7, what is x?', options: ['7', '5', '12', 'Both'], correctIndex: 0, explanation: 'Assignment replaces the value.' },
          ],
        },
        openerItems: [],
      },
      zpdSnapshot: { nodeId },
      status: 'ready',
    })
    .returning();
  return lesson;
}

async function seedWinCheckAttempts(
  learnerId: string,
  lessonId: string,
  items: Array<{ id: string; correct: boolean }>,
) {
  for (const item of items) {
    await testDb.insert(s.attemptEvents).values({
      learnerId,
      lessonId,
      blockId: item.id,
      eventType: 'win_check',
      correct: item.correct,
      payload: {},
    });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('distillLesson', () => {
  beforeAll(() => {
    process.env.AI_FAKE_LLM = '1';
  });

  beforeEach(resetDb);
  afterAll(() => testPool.end());

  // ── Full round-trip ────────────────────────────────────────────────────────

  it('full round-trip: records inserted with correct seq + evidence FK', async () => {
    const { learner, track, node } = await seedWorld('rtrip');
    const lesson = await seedReadyLesson(track.id, node.id);

    // Seed first-attempt-correct events for both win-check items
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    const result = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    expect(result.inserted).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.recordIds.length).toBeGreaterThan(0);

    // Verify record has correct evidence jsonb
    const [rec] = await testDb
      .select()
      .from(s.learningRecords)
      .where(eq(s.learningRecords.id, result.recordIds[0]));
    expect(rec).toBeTruthy();
    expect(rec.trackId).toBe(track.id);
    expect(rec.seq).toBeGreaterThan(0);

    const evidence = rec.evidence as Record<string, unknown>;
    expect(evidence.lessonId).toBe(lesson.id);
    expect(evidence.source).toBe('distiller');
    // attemptEventIds must be populated with the win_check event ids actually used.
    expect(Array.isArray(evidence.attemptEventIds)).toBe(true);
    expect((evidence.attemptEventIds as string[]).length).toBeGreaterThan(0);
  });

  it('full round-trip: glossary term promoted with FK to first record', async () => {
    const { learner, track, node } = await seedWorld('gterm');
    const lesson = await seedReadyLesson(track.id, node.id);
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    const result = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    // The fixture promotes 'variable'
    expect(result.promotedTermIds.length).toBeGreaterThan(0);

    const [term] = await testDb
      .select()
      .from(s.glossaryTerms)
      .where(eq(s.glossaryTerms.id, result.promotedTermIds[0]));
    expect(term.term).toBe('variable');
    expect(term.definition).toBe('A named container for a value.');
    expect(term.promotionEvidenceRecordId).toBe(result.recordIds[0]);
    expect(term.trackId).toBe(track.id);
  });

  it('full round-trip: review card created for each promoted term (FSRS bridge)', async () => {
    const { learner, track, node } = await seedWorld('card');
    const lesson = await seedReadyLesson(track.id, node.id);
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    const result = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    expect(result.cardIds.length).toBe(result.promotedTermIds.length);
    expect(result.cardIds.length).toBeGreaterThan(0);

    // Card should be for the learner and point to the glossary term
    const [card] = await testDb
      .select()
      .from(s.reviewCards)
      .where(eq(s.reviewCards.id, result.cardIds[0]));
    expect(card.learnerId).toBe(learner.id);
    expect(card.glossaryTermId).toBe(result.promotedTermIds[0]);
    expect(card.state).toBe(0); // New
  });

  it('full round-trip: node mastery set to demonstrated', async () => {
    const { learner, track, node } = await seedWorld('mastery');
    const lesson = await seedReadyLesson(track.id, node.id);
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    const [updatedNode] = await testDb
      .select()
      .from(s.skillNodes)
      .where(eq(s.skillNodes.id, node.id));
    expect(updatedNode.mastery).toBe('demonstrated');
  });

  it('idempotent: second call is a no-op', async () => {
    const { learner, track, node } = await seedWorld('idem');
    const lesson = await seedReadyLesson(track.id, node.id);
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    const first = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });
    expect(first.skipped).toBe(false);

    const second = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });
    expect(second.skipped).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.recordIds).toHaveLength(0);

    // DB unchanged: still exactly the same number of records
    const records = await testDb
      .select()
      .from(s.learningRecords)
      .where(eq(s.learningRecords.trackId, track.id));
    expect(records).toHaveLength(first.recordIds.length);
  });

  // ── Dedup paths ────────────────────────────────────────────────────────────

  it('dedup: existing glossary term not re-promoted', async () => {
    const { learner, track, node } = await seedWorld('dedup-term');
    const lesson = await seedReadyLesson(track.id, node.id);
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    // Pre-insert the 'variable' term that the fixture would promote
    const seq = 1;
    const [existingRec] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id,
        seq,
        recordType: 'demonstrated_understanding',
        title: 'Pre-existing: knows variables',
        body: 'Seeded before distillation.',
        evidence: { source: 'seed' },
      })
      .returning();

    await testDb.insert(s.glossaryTerms).values({
      trackId: track.id,
      term: 'variable', // same as fixture promotion
      definition: 'Existing definition.',
      promotionEvidenceRecordId: existingRec.id,
    });

    const result = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    // Should not promote 'variable' again
    expect(result.promotedTermIds).toHaveLength(0);

    const terms = await testDb
      .select()
      .from(s.glossaryTerms)
      .where(eq(s.glossaryTerms.trackId, track.id));
    expect(terms).toHaveLength(1); // only the pre-existing one
    expect(terms[0].definition).toBe('Existing definition.'); // unchanged
  });

  it('dedup: duplicate title dropped (case-insensitive)', async () => {
    const { learner, track, node } = await seedWorld('dedup-title');
    const lesson = await seedReadyLesson(track.id, node.id);
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    // Pre-insert a record with the same title (case-insensitive) as the fixture's record
    // Fixture title: 'Can use variables to store and update values'
    const seq = 1;
    await testDb.insert(s.learningRecords).values({
      trackId: track.id,
      seq,
      recordType: 'demonstrated_understanding',
      title: 'CAN USE VARIABLES TO STORE AND UPDATE VALUES', // same as fixture, different case
      body: 'Pre-existing body.',
      evidence: { source: 'seed' },
    });

    await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    // The record with duplicate title should NOT have been inserted
    const records = await testDb
      .select()
      .from(s.learningRecords)
      .where(eq(s.learningRecords.trackId, track.id));

    // Only 1 record (the pre-existing seed); the duplicate was dropped
    const distilledWithTitle = records.filter(
      (r) => r.title.toLowerCase() === 'can use variables to store and update values',
    );
    expect(distilledWithTitle).toHaveLength(1); // the seed, not an additional copy
  });

  // ── Umbrella-record path ───────────────────────────────────────────────────

  it('umbrella-record: promotions-only LLM output creates umbrella record first', async () => {
    const { learner, track, node } = await seedWorld('umbrella');
    const lesson = await seedReadyLesson(track.id, node.id);
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    // Use a sequential model override:
    //   call 1 → distill-records: promotions-only (triggers umbrella record)
    //   call 2 → create-reference-doc: valid reference doc
    const { createSequentialMockLanguageModel } = await import('./mock-llm-helper');
    const promotionsOnlyOutput = JSON.stringify({
      records: [],
      glossaryPromotions: [{ term: 'assignment', definition: 'Storing a value in a variable.' }],
    });
    const refDocOutput = JSON.stringify({
      title: 'Variables and types',
      docType: 'cheat_sheet',
      sections: [{ heading: 'Overview', markdown: 'Key concepts from the lesson.' }],
    });
    const mockModel = createSequentialMockLanguageModel([promotionsOnlyOutput, refDocOutput]);

    const result = await distillLesson(testDb, {
      lessonId: lesson.id,
      learnerId: learner.id,
      modelOverride: mockModel,
    });

    // Should have created an umbrella record
    expect(result.recordIds).toHaveLength(1);
    const [umbrellaRec] = await testDb
      .select()
      .from(s.learningRecords)
      .where(eq(s.learningRecords.id, result.recordIds[0]));
    expect(umbrellaRec.title).toMatch(/Completed:/i);
    expect(umbrellaRec.recordType).toBe('demonstrated_understanding');

    // Promotion should have the umbrella record as FK
    expect(result.promotedTermIds).toHaveLength(1);
    const [term] = await testDb
      .select()
      .from(s.glossaryTerms)
      .where(eq(s.glossaryTerms.id, result.promotedTermIds[0]));
    expect(term.promotionEvidenceRecordId).toBe(result.recordIds[0]);

    // Umbrella path also creates a reference doc (step 7 runs whenever recordIds.length > 0)
    expect(result.referenceDocId).not.toBeNull();
  });

  // ── First-attempt-only win-check tally ─────────────────────────────────────

  it('first-attempt-only: wrong-then-right does NOT count as a pass', () => {
    // Test the logic: 2 items, one wrong on first attempt, one correct
    // With 2 items, need ceil(0.85 * 2) = 2 correct to pass.
    // Wrong-then-right = only 1 first-attempt-correct → should NOT pass.
    const firstAttemptCorrect = 1; // item1: correct; item2: wrong first
    const total = 2;
    expect(winCheckPassed(firstAttemptCorrect, total)).toBe(false);
  });

  it('first-attempt-only: all correct on first attempt passes', () => {
    const firstAttemptCorrect = 2;
    const total = 2;
    expect(winCheckPassed(firstAttemptCorrect, total)).toBe(true);
  });

  it('first-attempt-only: partial score (1/4) does not pass', () => {
    expect(winCheckPassed(1, 4)).toBe(false);
  });

  it('first-attempt-only: 4/4 passes', () => {
    expect(winCheckPassed(4, 4)).toBe(true);
  });

  // ── Integration: tally bug regression ─────────────────────────────────────
  // Reproduces the OLD MIN(created_at)-then-equality bug shape:
  // two win_check events for one item (first wrong, second correct at a later
  // timestamp) + one correct-first for the other item.
  // Distiller must report answered=2, firstAttemptCorrect=1, so passed=false.
  it('tally regression: wrong-then-right item is first-attempt-incorrect (DB round-trip)', async () => {
    const { learner, track, node } = await seedWorld('tally-reg');
    const lesson = await seedReadyLesson(track.id, node.id);

    // wc1: first attempt WRONG
    const [e1] = await testDb.insert(s.attemptEvents).values({
      learnerId: learner.id,
      lessonId: lesson.id,
      blockId: 'wc1',
      eventType: 'win_check',
      correct: false,
      payload: {},
    }).returning();
    // wc1: second attempt correct — distinct timestamp guaranteed by serial insert + DB default
    await testDb.insert(s.attemptEvents).values({
      learnerId: learner.id,
      lessonId: lesson.id,
      blockId: 'wc1',
      eventType: 'win_check',
      correct: true,
      payload: {},
    });
    // wc2: first attempt correct
    const [e2] = await testDb.insert(s.attemptEvents).values({
      learnerId: learner.id,
      lessonId: lesson.id,
      blockId: 'wc2',
      eventType: 'win_check',
      correct: true,
      payload: {},
    }).returning();

    const result = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    // evidence ids must contain exactly the first-attempt event ids (e1 for wc1, e2 for wc2)
    const evidence = (await testDb
      .select()
      .from(s.learningRecords)
      .where(eq(s.learningRecords.id, result.recordIds[0]))
    )[0].evidence as Record<string, unknown>;

    const usedIds = evidence.attemptEventIds as string[];
    expect(usedIds).toContain(e1.id);   // first attempt for wc1 (wrong)
    expect(usedIds).toContain(e2.id);   // first attempt for wc2 (correct)
    expect(usedIds.length).toBe(2);

    // With 1/2 first-attempt-correct, winCheckPassed(1,2)=false → distiller
    // builds evidence but the LLM still runs (evidence summary shows 1 correct).
    // The key assertion is that the evidence shows only 1 first-attempt-correct.
    const evidenceSummaryCorrect = usedIds.filter(
      (id) => id === e2.id,  // e2 is the correct-first attempt
    );
    expect(evidenceSummaryCorrect.length).toBe(1);
  });

  it('tally regression: all-correct-first → passed evidence (DB round-trip)', async () => {
    const { learner, track, node } = await seedWorld('tally-pass');
    const lesson = await seedReadyLesson(track.id, node.id);

    // Both items answered correctly on first attempt
    const [e1] = await testDb.insert(s.attemptEvents).values({
      learnerId: learner.id,
      lessonId: lesson.id,
      blockId: 'wc1',
      eventType: 'win_check',
      correct: true,
      payload: {},
    }).returning();
    const [e2] = await testDb.insert(s.attemptEvents).values({
      learnerId: learner.id,
      lessonId: lesson.id,
      blockId: 'wc2',
      eventType: 'win_check',
      correct: true,
      payload: {},
    }).returning();

    const result = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    expect(result.inserted).toBe(true);
    const evidence = (await testDb
      .select()
      .from(s.learningRecords)
      .where(eq(s.learningRecords.id, result.recordIds[0]))
    )[0].evidence as Record<string, unknown>;

    const usedIds = evidence.attemptEventIds as string[];
    expect(usedIds).toContain(e1.id);
    expect(usedIds).toContain(e2.id);
    expect(usedIds.length).toBe(2);
  });

  // ── Reference doc (step 7) ────────────────────────────────────────────────

  it('reference doc: created on distill when records are inserted', async () => {
    const { learner, track, node } = await seedWorld('refDoc-create');
    const lesson = await seedReadyLesson(track.id, node.id);
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    const result = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    expect(result.inserted).toBe(true);
    expect(result.referenceDocId).not.toBeNull();

    // Verify the doc exists in DB with correct shape
    const [doc] = await testDb
      .select()
      .from(s.referenceDocs)
      .where(eq(s.referenceDocs.id, result.referenceDocId!));

    expect(doc).toBeTruthy();
    expect(doc.trackId).toBe(track.id);
    expect(doc.title).toBeTruthy();
    expect(doc.docType).toBeTruthy();
    expect(doc.linkedLessonIds).toContain(lesson.id);

    const content = doc.content as { sections: Array<{ heading: string; markdown: string }> };
    expect(Array.isArray(content.sections)).toBe(true);
    expect(content.sections.length).toBeGreaterThanOrEqual(1);
  });

  it('reference doc: same-title second lesson updates not duplicates', async () => {
    const { learner, track, node } = await seedWorld('refDoc-update');
    // Two lessons both produce a reference doc with the same title.
    // lesson1 uses AI_FAKE_LLM fixtures; lesson2 uses a sequential mock with:
    //   - a DIFFERENT record title (so it isn't deduped by the code-side gate)
    //   - the SAME reference doc title (so step 7 hits the upsert path)
    const lesson1 = await seedReadyLesson(track.id, node.id, 1);
    const lesson2 = await seedReadyLesson(track.id, node.id, 2);

    await seedWinCheckAttempts(learner.id, lesson1.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);
    await seedWinCheckAttempts(learner.id, lesson2.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    // lesson1 uses AI_FAKE_LLM fixture (record title: "Can use variables to store and update values")
    const result1 = await distillLesson(testDb, { lessonId: lesson1.id, learnerId: learner.id });
    expect(result1.referenceDocId).not.toBeNull();

    // lesson2: different record title (unique) + same reference doc title
    const { createSequentialMockLanguageModel } = await import('./mock-llm-helper');
    const lesson2DistillOutput = JSON.stringify({
      records: [
        {
          recordType: 'demonstrated_understanding',
          title: 'Can apply variable assignment in practice',  // different from lesson1
          body: 'The learner demonstrated ability to apply variable assignment concepts.',
        },
      ],
      glossaryPromotions: [],
    });
    const lesson2RefDocOutput = JSON.stringify({
      title: 'Variables and types',  // SAME title as lesson1's doc
      docType: 'cheat_sheet',
      sections: [{ heading: 'Quick reference', markdown: 'Updated content for lesson 2.' }],
    });
    const mockModel2 = createSequentialMockLanguageModel([lesson2DistillOutput, lesson2RefDocOutput]);

    // The idempotency guard is per-lesson; lesson2 has different lessonId so it proceeds.
    const result2 = await distillLesson(testDb, {
      lessonId: lesson2.id,
      learnerId: learner.id,
      modelOverride: mockModel2,
    });
    expect(result2.inserted).toBe(true);
    expect(result2.referenceDocId).not.toBeNull();

    // Both calls should resolve to the SAME doc (same title → upsert path)
    expect(result2.referenceDocId).toBe(result1.referenceDocId);

    // Only one reference doc in the DB for this track
    const docs = await testDb
      .select()
      .from(s.referenceDocs)
      .where(eq(s.referenceDocs.trackId, track.id));
    expect(docs).toHaveLength(1);
  });

  it('reference doc: linkedLessonIds appends on second lesson with same title', async () => {
    const { learner, track, node } = await seedWorld('refDoc-append');
    const lesson1 = await seedReadyLesson(track.id, node.id, 1);
    const lesson2 = await seedReadyLesson(track.id, node.id, 2);

    await seedWinCheckAttempts(learner.id, lesson1.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);
    await seedWinCheckAttempts(learner.id, lesson2.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    // lesson1 uses AI_FAKE_LLM fixtures
    await distillLesson(testDb, { lessonId: lesson1.id, learnerId: learner.id });

    // lesson2 uses a sequential mock:
    //   call 1 → distill-records: unique record title (not deduped)
    //   call 2 → create-reference-doc: same doc title (triggers upsert + array_append)
    const { createSequentialMockLanguageModel } = await import('./mock-llm-helper');
    const lesson2DistillOutput = JSON.stringify({
      records: [
        {
          recordType: 'demonstrated_understanding',
          title: 'Can apply variable assignment in practice',
          body: 'The learner demonstrated the ability to work with variable assignment.',
        },
      ],
      glossaryPromotions: [],
    });
    const lesson2RefDocOutput = JSON.stringify({
      title: 'Variables and types',  // same title as lesson1
      docType: 'cheat_sheet',
      sections: [{ heading: 'Quick reference', markdown: 'Updated content.' }],
    });
    const mockModel2 = createSequentialMockLanguageModel([lesson2DistillOutput, lesson2RefDocOutput]);

    await distillLesson(testDb, { lessonId: lesson2.id, learnerId: learner.id, modelOverride: mockModel2 });

    const [doc] = await testDb
      .select()
      .from(s.referenceDocs)
      .where(eq(s.referenceDocs.trackId, track.id));

    // Both lesson ids should be in linkedLessonIds
    expect(doc.linkedLessonIds).toContain(lesson1.id);
    expect(doc.linkedLessonIds).toContain(lesson2.id);
    expect(doc.linkedLessonIds).toHaveLength(2);
  });

  it('reference doc: idempotent second call does not create a reference doc', async () => {
    const { learner, track, node } = await seedWorld('refDoc-idem');
    const lesson = await seedReadyLesson(track.id, node.id);
    await seedWinCheckAttempts(learner.id, lesson.id, [
      { id: 'wc1', correct: true },
      { id: 'wc2', correct: true },
    ]);

    await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });

    // Second call is skipped by idempotency
    const result2 = await distillLesson(testDb, { lessonId: lesson.id, learnerId: learner.id });
    expect(result2.skipped).toBe(true);
    expect(result2.referenceDocId).toBeNull();

    // Still only one doc in DB
    const docs = await testDb
      .select()
      .from(s.referenceDocs)
      .where(eq(s.referenceDocs.trackId, track.id));
    expect(docs).toHaveLength(1);
  });
});

// ── Fixture validation ─────────────────────────────────────────────────────────

describe('distill-records fixture', () => {
  it('fixture parses against distillOutputSchema', async () => {
    const { fakeOutputs } = await import('@/lib/ai-fixtures');
    const { distillOutputSchema } = await import('@/server/lessons/distiller');
    const parsed = distillOutputSchema.safeParse(fakeOutputs['distill-records']);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.records).toHaveLength(1);
    expect(parsed.data.records[0].recordType).toBe('demonstrated_understanding');
    expect(parsed.data.records[0].title).toBe('Can use variables to store and update values');
    expect(parsed.data.glossaryPromotions).toHaveLength(1);
    expect(parsed.data.glossaryPromotions[0].term).toBe('variable');
    expect(parsed.data.glossaryPromotions[0].definition).toBe('A named container for a value.');
  });
});

describe('create-reference-doc fixture', () => {
  it('fixture parses against createReferenceDocSchema', async () => {
    const { fakeOutputs } = await import('@/lib/ai-fixtures');
    const { createReferenceDocSchema } = await import('@/server/lessons/distiller');
    const parsed = createReferenceDocSchema.safeParse(fakeOutputs['create-reference-doc']);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.title).toBe('Variables and types');
    expect(parsed.data.docType).toBe('cheat_sheet');
    expect(parsed.data.sections.length).toBeGreaterThanOrEqual(1);
    expect(parsed.data.sections.length).toBeLessThanOrEqual(6);
    for (const section of parsed.data.sections) {
      expect(section.heading.length).toBeGreaterThan(0);
      expect(section.markdown.length).toBeGreaterThan(0);
    }
  });
});
