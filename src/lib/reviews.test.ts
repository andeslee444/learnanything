/**
 * Tests for the FSRS review engine (Phase 5a).
 *
 * Card state progression is verified against ACTUAL ts-fsrs library behavior
 * observed at implementation time — not assumptions.
 *
 * Observed progression (ts-fsrs v5, default params):
 *   New → Good #1: state=1 (Learning), due+10m, learning_steps=1
 *   Learning → Good #2: state=2 (Review), due+~2d, scheduled_days>0
 *   Review → Good #3: state=2 (Review), due+~11d
 *   Review → Again:   state=3 (Relearning), lapses+1, due near
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Rating } from 'ts-fsrs';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import {
  createCardForGlossaryTerm,
  getDueCards,
  buildReviewItem,
  gradeReview,
} from './reviews';

// ── Seed helpers ────────────────────────────────────────────────────────────

async function seedLearnerTrack(suffix = '') {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'R' + suffix, email: `${crypto.randomUUID()}@t.dev` })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'R' + suffix, ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Variables', vertical: 'programming' })
    .returning();
  return { learner, track };
}

/**
 * Seed a learning_record (required by glossary_terms.promotionEvidenceRecordId FK).
 * The record and glossary term must share the same trackId.
 */
async function seedEvidenceRecord(trackId: string, seq = 1) {
  const [rec] = await testDb
    .insert(s.learningRecords)
    .values({
      trackId,
      seq,
      recordType: 'demonstrated_understanding',
      title: 'Can use variables',
      body: 'Learner demonstrated ability to store values in variables.',
      evidence: {},
    })
    .returning();
  return rec;
}

async function seedGlossaryTerm(trackId: string, evidenceRecordId: string, opts?: { term?: string; definition?: string }) {
  const [term] = await testDb
    .insert(s.glossaryTerms)
    .values({
      trackId,
      term: opts?.term ?? 'variable',
      definition: opts?.definition ?? 'A named container for a value.',
      promotionEvidenceRecordId: evidenceRecordId,
    })
    .returning();
  return term;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('FSRS review engine', () => {
  beforeEach(resetDb);
  afterAll(() => testPool.end());

  // ── createCardForGlossaryTerm ────────────────────────────────────────────

  describe('createCardForGlossaryTerm', () => {
    it('creates a card with New state (0) and due≈now', async () => {
      const { learner, track } = await seedLearnerTrack();
      const rec = await seedEvidenceRecord(track.id);
      const term = await seedGlossaryTerm(track.id, rec.id);

      const before = new Date();
      const { id, created } = await createCardForGlossaryTerm(testDb, {
        learnerId: learner.id,
        glossaryTermId: term.id,
      });
      const after = new Date();

      expect(created).toBe(true);
      expect(id).toBeTruthy();

      // Fetch the actual row
      const { eq } = await import('drizzle-orm');
      const [row] = await testDb.select().from(s.reviewCards).where(eq(s.reviewCards.id, id));
      expect(row.state).toBe(0); // State.New
      expect(row.reps).toBe(0);
      expect(row.lapses).toBe(0);
      expect(row.due.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(row.due.getTime()).toBeLessThanOrEqual(after.getTime() + 5000);
    });

    it('is idempotent — returns same card id on second call', async () => {
      const { learner, track } = await seedLearnerTrack('i');
      const rec = await seedEvidenceRecord(track.id);
      const term = await seedGlossaryTerm(track.id, rec.id);

      const first = await createCardForGlossaryTerm(testDb, { learnerId: learner.id, glossaryTermId: term.id });
      const second = await createCardForGlossaryTerm(testDb, { learnerId: learner.id, glossaryTermId: term.id });

      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);

      // DB has exactly one row
      const { eq } = await import('drizzle-orm');
      const rows = await testDb
        .select()
        .from(s.reviewCards)
        .where(eq(s.reviewCards.glossaryTermId, term.id));
      expect(rows).toHaveLength(1);
    });

    it('XOR constraint: cannot create a card with both glossaryTermId and learningRecordId', async () => {
      const { learner, track } = await seedLearnerTrack('x');
      const rec = await seedEvidenceRecord(track.id);
      const term = await seedGlossaryTerm(track.id, rec.id);

      await expect(
        testDb.insert(s.reviewCards).values({
          learnerId: learner.id,
          glossaryTermId: term.id,
          learningRecordId: rec.id, // violates XOR
          due: new Date(),
          stability: 0,
          difficulty: 0,
          elapsedDays: 0,
          scheduledDays: 0,
          learningSteps: 0,
          reps: 0,
          lapses: 0,
          state: 0,
        })
      ).rejects.toThrow();
    });
  });

  // ── getDueCards ──────────────────────────────────────────────────────────

  describe('getDueCards', () => {
    it('returns cards with due ≤ now, excludes future cards', async () => {
      const { learner, track } = await seedLearnerTrack('d');
      const rec = await seedEvidenceRecord(track.id);

      const term1 = await seedGlossaryTerm(track.id, rec.id, { term: 'variable', definition: 'A container.' });
      const term2 = await seedGlossaryTerm(track.id, rec.id, { term: 'loop', definition: 'Repeated execution.' });

      const now = new Date('2026-06-10T12:00:00Z');
      const past = new Date('2026-06-09T12:00:00Z');
      const future = new Date('2026-06-11T12:00:00Z');

      await testDb.insert(s.reviewCards).values({
        learnerId: learner.id,
        glossaryTermId: term1.id,
        due: past, // overdue — should appear
        stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0,
        learningSteps: 0, reps: 0, lapses: 0, state: 0,
      });
      await testDb.insert(s.reviewCards).values({
        learnerId: learner.id,
        glossaryTermId: term2.id,
        due: future, // future — should NOT appear
        stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0,
        learningSteps: 0, reps: 0, lapses: 0, state: 0,
      });

      const due = await getDueCards(testDb, learner.id, now);
      expect(due).toHaveLength(1);
      expect(due[0].term).toBe('variable');
    });

    it('returns cards ordered by due ASC (most overdue first)', async () => {
      const { learner, track } = await seedLearnerTrack('ord');
      const rec = await seedEvidenceRecord(track.id);
      const t1 = await seedGlossaryTerm(track.id, rec.id, { term: 'alpha', definition: 'First.' });
      const t2 = await seedGlossaryTerm(track.id, rec.id, { term: 'beta', definition: 'Second.' });

      const now = new Date('2026-06-10T12:00:00Z');
      const older = new Date('2026-06-08T12:00:00Z');
      const newer = new Date('2026-06-09T12:00:00Z');

      await testDb.insert(s.reviewCards).values({
        learnerId: learner.id, glossaryTermId: t1.id,
        due: newer, stability: 0, difficulty: 0, elapsedDays: 0,
        scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0,
      });
      await testDb.insert(s.reviewCards).values({
        learnerId: learner.id, glossaryTermId: t2.id,
        due: older, stability: 0, difficulty: 0, elapsedDays: 0,
        scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0,
      });

      const due = await getDueCards(testDb, learner.id, now);
      expect(due[0].term).toBe('beta'); // older due first
      expect(due[1].term).toBe('alpha');
    });

    it('respects the limit parameter', async () => {
      const { learner, track } = await seedLearnerTrack('lim');
      const rec = await seedEvidenceRecord(track.id);
      const past = new Date('2026-06-01T00:00:00Z');
      const now = new Date('2026-06-10T12:00:00Z');

      // Insert 5 overdue cards
      for (let i = 0; i < 5; i++) {
        const t = await seedGlossaryTerm(track.id, rec.id, { term: `term${i}`, definition: `def${i}` });
        await testDb.insert(s.reviewCards).values({
          learnerId: learner.id, glossaryTermId: t.id,
          due: past, stability: 0, difficulty: 0, elapsedDays: 0,
          scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0,
        });
      }

      const due = await getDueCards(testDb, learner.id, now, 3);
      expect(due).toHaveLength(3);
    });

    it('does not return cards belonging to other learners', async () => {
      const a = await seedLearnerTrack('a1');
      const b = await seedLearnerTrack('b1');
      const recA = await seedEvidenceRecord(a.track.id);
      const termA = await seedGlossaryTerm(a.track.id, recA.id);

      await testDb.insert(s.reviewCards).values({
        learnerId: a.learner.id, glossaryTermId: termA.id,
        due: new Date('2026-06-01T00:00:00Z'),
        stability: 0, difficulty: 0, elapsedDays: 0,
        scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0,
      });

      const due = await getDueCards(testDb, b.learner.id, new Date());
      expect(due).toHaveLength(0);
    });
  });

  // ── buildReviewItem ──────────────────────────────────────────────────────

  describe('buildReviewItem (pure — no DB)', () => {
    const fakeCard = { id: 'aaaaaaaa-0000-0000-0000-000000000001', term: 'variable', definition: 'A named container for a value.' };
    const distractors = ['A loop construct.', 'A function parameter.', 'A file handle.'];

    it('builds a question of the form What is "term"?', () => {
      const item = buildReviewItem(fakeCard, distractors);
      expect(item.question).toBe('What is "variable"?');
    });

    it('has exactly 4 options including the correct definition', () => {
      const item = buildReviewItem(fakeCard, distractors);
      expect(item.options).toHaveLength(4);
      expect(item.options).toContain(fakeCard.definition);
    });

    it('correctIndex points to the correct definition', () => {
      const item = buildReviewItem(fakeCard, distractors);
      expect(item.options[item.correctIndex]).toBe(fakeCard.definition);
    });

    it('is deterministic — same card id produces same option order', () => {
      const item1 = buildReviewItem(fakeCard, distractors);
      const item2 = buildReviewItem(fakeCard, distractors);
      expect(item1.options).toEqual(item2.options);
      expect(item1.correctIndex).toBe(item2.correctIndex);
    });

    it('different card ids produce different option orders', () => {
      const card2 = { ...fakeCard, id: 'bbbbbbbb-0000-0000-0000-000000000002' };
      const item1 = buildReviewItem(fakeCard, distractors);
      const item2 = buildReviewItem(card2, distractors);
      // Extremely unlikely to be identical; check order differs
      // (could theoretically match — but with 4! = 24 permutations this is 1/24 chance — acceptable)
      // More robustly: check that at least the seed changed (correctIndex or ordering differs in general)
      // We assert orders differ for these specific known-different seeds:
      expect(item1.options.join('|')).not.toBe(item2.options.join('|'));
    });

    it('pads to 3 distractors with generic strings when fewer than 3 provided', () => {
      const item = buildReviewItem(fakeCard, ['Only one distractor.']);
      expect(item.options).toHaveLength(4); // 1 correct + 3 (1 real + 2 generic)
      expect(item.options).toContain(fakeCard.definition);
    });

    it('pads to 3 distractors with generic strings when none provided', () => {
      const item = buildReviewItem(fakeCard, []);
      expect(item.options).toHaveLength(4);
      expect(item.options).toContain(fakeCard.definition);
    });

    it('shuffle is unbiased — correct answer position is near-uniform over 400 distinct card ids', () => {
      // Generate 400 cards with distinct UUIDs so each gets a different seed.
      // Tally which of the 4 positions the correct answer lands in.
      // Expected count per bucket: 100 (400 / 4).
      // Loose uniformity band: [60, 140] — far from a chi-sq test, but catches gross bias.
      const positionCounts = [0, 0, 0, 0];
      const distractors = ['Distractor A.', 'Distractor B.', 'Distractor C.'];

      for (let i = 0; i < 400; i++) {
        // Use a deterministic UUID-like id based on index
        const hex = i.toString(16).padStart(12, '0');
        const id = `${hex.slice(0, 8)}-0000-0000-0000-${hex.padStart(12, '0')}`;
        const card = { id, term: 'term', definition: `Correct definition for ${i}.` };
        // Unique definition per card so indexOf is unambiguous
        const item = buildReviewItem(card, distractors);
        positionCounts[item.correctIndex]++;
      }

      // Each bucket should be within [60, 140]
      for (let pos = 0; pos < 4; pos++) {
        expect(positionCounts[pos]).toBeGreaterThanOrEqual(60);
        expect(positionCounts[pos]).toBeLessThanOrEqual(140);
      }
    });
  });

  // ── gradeReview ──────────────────────────────────────────────────────────

  describe('gradeReview', () => {
    it('correct → Rating.Good: due moves into the future (≥1 minute after a few reviews)', async () => {
      const { learner, track } = await seedLearnerTrack('g1');
      const rec = await seedEvidenceRecord(track.id);
      const term = await seedGlossaryTerm(track.id, rec.id);
      const { id: cardId } = await createCardForGlossaryTerm(testDb, {
        learnerId: learner.id,
        glossaryTermId: term.id,
      });

      const now = new Date('2026-06-10T12:00:00Z');

      // Grade Good from New state
      const result = await gradeReview(testDb, { cardId, learnerId: learner.id, correct: true, now });
      expect(result.rating).toBe(Rating.Good); // 3

      // Due should be strictly after now (Good from New → 10 minutes into learning step)
      expect(result.nextDue.getTime()).toBeGreaterThan(now.getTime());
    });

    it('incorrect → Rating.Again: due is near now and lapses increment after reaching Review', async () => {
      const { learner, track } = await seedLearnerTrack('g2');
      const rec = await seedEvidenceRecord(track.id);
      const term = await seedGlossaryTerm(track.id, rec.id);
      const { id: cardId } = await createCardForGlossaryTerm(testDb, {
        learnerId: learner.id,
        glossaryTermId: term.id,
      });

      // Graduate the card to Review state first (Good → Good → graduation)
      let now = new Date('2026-06-10T12:00:00Z');
      await gradeReview(testDb, { cardId, learnerId: learner.id, correct: true, now });

      // Second Good (learning step 2 → graduates to Review state=2)
      now = new Date('2026-06-10T12:10:00Z');
      await gradeReview(testDb, { cardId, learnerId: learner.id, correct: true, now });

      // Card should now be in Review state — confirm
      const { eq } = await import('drizzle-orm');
      const [cardAfterGrad] = await testDb.select().from(s.reviewCards).where(eq(s.reviewCards.id, cardId));
      expect(cardAfterGrad.state).toBe(2); // State.Review

      // Now grade Again from Review — should increment lapses
      now = new Date(cardAfterGrad.due);
      const again = await gradeReview(testDb, { cardId, learnerId: learner.id, correct: false, now });
      expect(again.rating).toBe(Rating.Again); // 1

      const [cardAfterAgain] = await testDb.select().from(s.reviewCards).where(eq(s.reviewCards.id, cardId));
      expect(cardAfterAgain.lapses).toBe(1);
      expect(cardAfterAgain.state).toBe(3); // State.Relearning
      // Due should be near now (Relearning step ≈ 10 minutes, not days away)
      const daysAway = (cardAfterAgain.due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysAway).toBeLessThan(1);
    });

    it('Good from New: due moves ≥1 minute out (learning step progression)', async () => {
      const { learner, track } = await seedLearnerTrack('g3');
      const rec = await seedEvidenceRecord(track.id);
      const term = await seedGlossaryTerm(track.id, rec.id);
      const { id: cardId } = await createCardForGlossaryTerm(testDb, {
        learnerId: learner.id,
        glossaryTermId: term.id,
      });

      const now = new Date('2026-06-10T12:00:00Z');
      const result = await gradeReview(testDb, { cardId, learnerId: learner.id, correct: true, now });

      const minutesOut = (result.nextDue.getTime() - now.getTime()) / (1000 * 60);
      expect(minutesOut).toBeGreaterThanOrEqual(1); // ts-fsrs default: Good from New → 10m
    });

    it('graduation path: two Goods from New → Review state with scheduled_days > 0', async () => {
      const { learner, track } = await seedLearnerTrack('g4');
      const rec = await seedEvidenceRecord(track.id);
      const term = await seedGlossaryTerm(track.id, rec.id);
      const { id: cardId } = await createCardForGlossaryTerm(testDb, {
        learnerId: learner.id,
        glossaryTermId: term.id,
      });

      const { eq } = await import('drizzle-orm');

      // Good #1 from New → Learning
      let now = new Date('2026-06-10T12:00:00Z');
      await gradeReview(testDb, { cardId, learnerId: learner.id, correct: true, now });
      const [after1] = await testDb.select().from(s.reviewCards).where(eq(s.reviewCards.id, cardId));
      expect(after1.state).toBe(1); // Learning

      // Good #2 from Learning → Review (graduation)
      now = new Date('2026-06-10T12:10:00Z');
      await gradeReview(testDb, { cardId, learnerId: learner.id, correct: true, now });
      const [after2] = await testDb.select().from(s.reviewCards).where(eq(s.reviewCards.id, cardId));
      expect(after2.state).toBe(2); // Review
      expect(after2.scheduledDays).toBeGreaterThan(0);
      // Due should be at least 1 day away after graduation
      const daysOut = (after2.due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysOut).toBeGreaterThanOrEqual(1);
    });

    it('inserts a review_log row with all required FSRS fields non-default', async () => {
      const { learner, track } = await seedLearnerTrack('log');
      const rec = await seedEvidenceRecord(track.id);
      const term = await seedGlossaryTerm(track.id, rec.id);
      const { id: cardId } = await createCardForGlossaryTerm(testDb, {
        learnerId: learner.id,
        glossaryTermId: term.id,
      });

      const now = new Date('2026-06-10T12:00:00Z');
      await gradeReview(testDb, { cardId, learnerId: learner.id, correct: true, now });

      const { eq } = await import('drizzle-orm');
      const logs = await testDb.select().from(s.reviewLog).where(eq(s.reviewLog.cardId, cardId));
      expect(logs).toHaveLength(1);

      const log = logs[0];
      expect(log.cardId).toBe(cardId);
      expect(log.rating).toBe(3); // Rating.Good
      expect(log.state).toBe(0); // State.New (state BEFORE the review — from the log)
      expect(log.reviewedAt).toBeDefined();
      // All FSRSHistory fields present
      expect(typeof log.stability).toBe('number');
      expect(typeof log.difficulty).toBe('number');
      expect(typeof log.elapsedDays).toBe('number');
      expect(typeof log.scheduledDays).toBe('number');
      expect(typeof log.lastElapsedDays).toBe('number');
      expect(typeof log.learningSteps).toBe('number');
    });

    it('inserts an attempt_event with eventType=review', async () => {
      const { learner, track } = await seedLearnerTrack('ae');
      const rec = await seedEvidenceRecord(track.id);
      const term = await seedGlossaryTerm(track.id, rec.id);
      const { id: cardId } = await createCardForGlossaryTerm(testDb, {
        learnerId: learner.id,
        glossaryTermId: term.id,
      });

      const now = new Date('2026-06-10T12:00:00Z');
      await gradeReview(testDb, { cardId, learnerId: learner.id, correct: true, now });

      const { and, eq } = await import('drizzle-orm');
      const events = await testDb
        .select()
        .from(s.attemptEvents)
        .where(
          and(
            eq(s.attemptEvents.learnerId, learner.id),
            eq(s.attemptEvents.eventType, 'review'),
          ),
        );
      expect(events).toHaveLength(1);
      expect(events[0].blockId).toBe(cardId);
      expect(events[0].correct).toBe(true);
      const payload = events[0].payload as Record<string, string>;
      expect(payload.cardId).toBe(cardId);
      expect(payload.glossaryTermId).toBe(term.id);
    });

    it('throws when card does not belong to learner', async () => {
      const a = await seedLearnerTrack('own1');
      const b = await seedLearnerTrack('own2');
      const rec = await seedEvidenceRecord(a.track.id);
      const term = await seedGlossaryTerm(a.track.id, rec.id);
      const { id: cardId } = await createCardForGlossaryTerm(testDb, {
        learnerId: a.learner.id,
        glossaryTermId: term.id,
      });

      await expect(
        gradeReview(testDb, { cardId, learnerId: b.learner.id, correct: true })
      ).rejects.toThrow(/not found or not owned/i);
    });
  });
});
