/**
 * Integration tests for Task 4 of Phase 4b:
 *   - GET content strip (no correctIndex/explanation anywhere in the serialized shape)
 *   - sweepStaleLessons (qualifying rows fail+refund; ready rows untouched; threshold respected)
 *
 * These are integration tests: they use testDb (port 5433 TEST_DATABASE_URL).
 * Sweeper tests use the injectable `olderThanMs` param so we don't need clock manipulation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { placeHold } from '@/lib/credits';
import { sweepStaleLessons } from '@/server/lessons/pipeline';
import { stripContentAnswerKey } from '@/app/api/lessons/[lessonId]/route';

// ── helpers ───────────────────────────────────────────────────────────────────

async function seedUserLearnerTrack(email: string) {
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
    .values({ learnerId: learner.id, topic: 'Test topic', vertical: 'programming' })
    .returning();
  await testDb.insert(s.missions).values({
    trackId: track.id,
    whyText: 'learn to code',
    successCriteria: [{ description: 'write code' }],
    constraints: {},
    outOfScope: [],
  });
  return { userId: u.id, learnerId: learner.id, trackId: track.id };
}

// A realistic lesson content object that includes all quiz-bearing structures.
function makeRichContent() {
  return {
    openerItems: [
      {
        id: 'opener-0',
        question: 'What is a variable?',
        options: ['A named container', 'A loop', 'A function', 'A file'],
        correctIndex: 0,
        explanation: 'A variable is a named container for a value.',
      },
    ],
    blocks: [
      {
        type: 'article',
        heading: 'Variables',
        markdown: 'A variable stores a value.',
        citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
      },
      {
        type: 'quiz',
        items: [
          {
            id: 'q1',
            question: 'What does count = 3 do?',
            options: ['Stores 3', 'Prints 3', 'Deletes 3', 'None'],
            correctIndex: 0,
            explanation: 'count = 3 stores the value 3 in the variable count.',
          },
        ],
      },
      {
        type: 'worked_example',
        problem: 'Store then update a count.',
        steps: [
          { text: 'Write count = 5 to create the variable.' },
          { text: 'Write count = 7 to update the value.' },
        ],
        completionItem: {
          id: 'we1',
          question: 'What does count hold after count = 7?',
          options: ['7', '5', '12', 'undefined'],
          correctIndex: 0,
          explanation: 'The assignment count = 7 overwrites the previous value.',
        },
      },
    ],
    winCheck: {
      items: [
        {
          id: 'wc1',
          question: 'What does a variable do?',
          options: ['Stores a value', 'Draws on screen', 'Sends email', 'Compiles'],
          correctIndex: 0,
          explanation: 'A variable is a named container for a value.',
        },
        {
          id: 'wc2',
          question: 'After x = 5 then x = 7, what is x?',
          options: ['7', '5', '12', 'Both'],
          correctIndex: 0,
          explanation: 'Assignment replaces the stored value.',
        },
      ],
    },
  };
}

/**
 * Deep scan an object tree for any occurrence of `correctIndex` or `explanation`.
 * Returns true if found (bad), false if clean (good).
 */
function hasAnswerKey(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some(hasAnswerKey);
  const record = obj as Record<string, unknown>;
  if ('correctIndex' in record || 'explanation' in record) return true;
  return Object.values(record).some(hasAnswerKey);
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await resetDb();
});
afterAll(() => testPool.end());

// ── GET strip: deep no-answer-key scan ───────────────────────────────────────

describe('stripContentAnswerKey — deep no-answer-key scan', () => {
  it('removes correctIndex and explanation from all quiz-bearing structures', () => {
    const content = makeRichContent();
    const stripped = stripContentAnswerKey(content);

    // Deep scan: must find NO correctIndex or explanation anywhere
    expect(hasAnswerKey(stripped)).toBe(false);
  });

  it('preserves all non-answer-key fields (question, options, id)', () => {
    const content = makeRichContent();
    const stripped = stripContentAnswerKey(content) as typeof content;

    // openerItems preserved (minus answer key)
    expect(stripped.openerItems).toHaveLength(1);
    expect((stripped.openerItems[0] as Record<string, unknown>).id).toBe('opener-0');
    expect((stripped.openerItems[0] as Record<string, unknown>).question).toBeTruthy();

    // quiz block items preserved
    const quizBlock = stripped.blocks.find((b) => (b as Record<string, unknown>).type === 'quiz') as {
      type: 'quiz';
      items: Record<string, unknown>[];
    };
    expect(quizBlock).toBeTruthy();
    expect(quizBlock.items[0].id).toBe('q1');
    expect(quizBlock.items[0].options).toBeTruthy();

    // worked_example completionItem preserved
    const weBlock = stripped.blocks.find((b) => (b as Record<string, unknown>).type === 'worked_example') as {
      type: 'worked_example';
      completionItem: Record<string, unknown>;
    };
    expect(weBlock).toBeTruthy();
    expect(weBlock.completionItem.id).toBe('we1');
    expect(weBlock.completionItem.question).toBeTruthy();

    // winCheck items preserved
    expect((stripped.winCheck as Record<string, unknown[]>).items).toHaveLength(2);
  });

  it('is idempotent: stripping already-stripped content is safe', () => {
    const content = makeRichContent();
    const once = stripContentAnswerKey(content);
    const twice = stripContentAnswerKey(once);
    expect(hasAnswerKey(twice)).toBe(false);
    expect(JSON.stringify(once)).toEqual(JSON.stringify(twice));
  });

  it('handles null/undefined content gracefully', () => {
    expect(stripContentAnswerKey(null)).toBeNull();
    expect(stripContentAnswerKey(undefined)).toBeUndefined();
    expect(stripContentAnswerKey('string')).toBe('string');
  });
});

// ── sweepStaleLessons integration ────────────────────────────────────────────

describe('sweepStaleLessons — integration', () => {
  it('transitions qualifying generating lesson to failed and refunds the hold', async () => {
    const { userId, trackId } = await seedUserLearnerTrack('sweep-qualify@t.dev');
    await testDb.insert(s.creditLedger).values({ userId, entryType: 'grant', amount: 3 });

    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'generating' })
      .returning();

    const holdId = await placeHold(testDb, userId, lesson.id);
    expect(holdId).toBeTruthy();

    // Negative olderThanMs → cutoff 1s in the future, so the freshly-created row
    // always qualifies. (0 is racy: the row's updated_at = Postgres now() can be
    // >= a cutoff computed from JS Date.now() in the same millisecond.)
    const result = await sweepStaleLessons(testDb, trackId, -1000);
    expect(result.swept).toBe(1);

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(row.status).toBe('failed');

    // Hold should be refunded
    const refunds = await testDb
      .select()
      .from(s.creditLedger)
      .where(eq(s.creditLedger.lessonId, lesson.id));
    const refundRow = refunds.find((r) => r.entryType === 'refund');
    expect(refundRow).toBeTruthy();
  });

  it('does not touch ready lessons', async () => {
    const { trackId } = await seedUserLearnerTrack('sweep-ready@t.dev');

    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'ready' })
      .returning();

    const result = await sweepStaleLessons(testDb, trackId, -1000);
    expect(result.swept).toBe(0);

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(row.status).toBe('ready');
  });

  it('respects the threshold: a freshly-created lesson is NOT swept when olderThanMs = 15min', async () => {
    const { trackId } = await seedUserLearnerTrack('sweep-threshold@t.dev');

    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'generating' })
      .returning();

    // Use a very large threshold — the fresh row is not old enough to qualify
    const result = await sweepStaleLessons(testDb, trackId, 15 * 60 * 1000);
    expect(result.swept).toBe(0);

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(row.status).toBe('generating');
  });

  it('sweeps only lessons in the given trackId', async () => {
    const { trackId: trackA } = await seedUserLearnerTrack('sweep-track-a@t.dev');
    const { trackId: trackB } = await seedUserLearnerTrack('sweep-track-b@t.dev');

    // Both generating
    await testDb
      .insert(s.lessons)
      .values([
        { trackId: trackA, seq: 1, spec: {}, status: 'generating' },
        { trackId: trackB, seq: 1, spec: {}, status: 'generating' },
      ]);

    // Sweep only trackA (negative threshold so fresh rows qualify without racing the clock)
    const result = await sweepStaleLessons(testDb, trackA, -1000);
    expect(result.swept).toBe(1);

    // trackB lesson should still be generating
    const [trackBLesson] = await testDb
      .select()
      .from(s.lessons)
      .where(eq(s.lessons.trackId, trackB));
    expect(trackBLesson.status).toBe('generating');
  });

  it('uses the injectable olderThanMs threshold — a fresh row IS swept with 0ms threshold', async () => {
    const { trackId } = await seedUserLearnerTrack('sweep-backdated@t.dev');

    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'generating' })
      .returning();

    // NOTE: The updatedAt trigger sets NEW.updated_at = now() on every UPDATE,
    // so we cannot backdate it via a normal UPDATE. Instead the sweeper accepts an
    // injectable negative olderThanMs (cutoff 1s in the future) so even
    // freshly-created rows qualify without racing the clock.
    // This verifies the cutoff condition works correctly.
    const result = await sweepStaleLessons(testDb, trackId, -1000);
    expect(result.swept).toBe(1);

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(row.status).toBe('failed');
  });

  it('ready + generating mixed: only the generating one is swept', async () => {
    // Track A: has one ready lesson (safe) and one generating lesson (stale)
    // We need two separate tracks because the unique index only allows one generating per track.
    const { trackId: trackReady } = await seedUserLearnerTrack('sweep-mixed-ready@t.dev');
    const { trackId: trackGen } = await seedUserLearnerTrack('sweep-mixed-gen@t.dev');

    const [readyLesson] = await testDb
      .insert(s.lessons)
      .values({ trackId: trackReady, seq: 1, spec: {}, status: 'ready' })
      .returning();

    const [genLesson] = await testDb
      .insert(s.lessons)
      .values({ trackId: trackGen, seq: 1, spec: {}, status: 'generating' })
      .returning();

    // Sweep trackGen — only the generating lesson qualifies (negative threshold avoids clock race)
    const result = await sweepStaleLessons(testDb, trackGen, -1000);
    expect(result.swept).toBe(1);

    const [genRow] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, genLesson.id));
    expect(genRow.status).toBe('failed');

    // ready lesson in trackReady is untouched
    const [readyRow] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, readyLesson.id));
    expect(readyRow.status).toBe('ready');
  });
});
