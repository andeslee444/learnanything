/**
 * sanitize.test.ts — Block-level sanitizer tests (Phase 10 Task 1).
 *
 * Test matrix:
 * 1. Fixture end-to-end: fake mode stable (same input → same output twice).
 * 2. openerItems dropped before LLM: spy proves zero 'sanitize-block' calls for openerItems;
 *    openers absent from result.
 * 3. Article rewritten ≠ original text but citations preserved.
 * 4. Malformed rewrite → dropped (mock returns a response violating the block schema).
 * 5. assertNoLearnerLeak unit tests (hit → throws; substring inside word → still throws).
 * 6. validateLessonContent requireOpeners option (default true unchanged, false skips).
 * 7. Moderation flagged/errored → SanitizeError with distinguishable retryable flag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  assertNoLearnerLeak,
  SanitizeError,
  sanitizeLessonContent,
} from './sanitize';
import { validateLessonContent } from './validate';
import type { LessonContent } from './blocks';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as s from '@/db/schema';

// ── helpers ───────────────────────────────────────────────────────────────────

type MockDb = NodePgDatabase<typeof s>;

/**
 * Build a minimal mock Drizzle db that returns canned data.
 * The query chain pattern: db.select().from(table).innerJoin(...).where(...) → row[].
 * We intercept at the final `.where()` call and return different data based on the
 * table that was queried. We use a simple state machine keyed on call sequence.
 */
function makeMockDb(opts: {
  trackRow?: { ageBand: string; displayName: string } | null;
  dossierRow?: {
    sources: Array<{ url: string }>;
    claims: Array<{ claim: string; sourceUrls: string[] }>;
    misconceptions: string[];
  } | null;
}): MockDb {
  // We need to serve different results for different queries.
  // Strategy: each `select()` returns a chainable object; `where()` returns the
  // appropriate result based on which query was last chained.
  let queryDepth = 0;

  const makeChain = (resultFn: () => unknown[]): ReturnType<MockDb['select']> => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => Promise.resolve(resultFn())),
    };
    return chain as unknown as ReturnType<MockDb['select']>;
  };

  const db = {
    select: vi.fn().mockImplementation(() => {
      queryDepth++;
      if (queryDepth === 1) {
        // First query: tracks join learners → trackRow
        return makeChain(() =>
          opts.trackRow ? [opts.trackRow] : [],
        );
      }
      // Second (and subsequent) queries: topicDossiers → dossierRow
      return makeChain(() =>
        opts.dossierRow ? [opts.dossierRow] : [],
      );
    }),
  } as unknown as MockDb;

  return db;
}

/** A minimal valid lesson row for sanitizeLessonContent. */
function makeLessonRow(overrides?: {
  blocks?: unknown[];
  winCheck?: unknown;
  openerItems?: unknown[];
  dossierId?: string;
}): typeof s.lessons.$inferSelect {
  const {
    blocks = [
      {
        type: 'article',
        heading: 'Variables: names for values',
        markdown:
          'Since you want to build a CLI tool, understanding variables will help you. ' +
          'Since you saw loops last lesson, variables are the next step.',
        citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
      },
      {
        type: 'quiz',
        items: [
          {
            id: 'q1',
            question: 'What does a variable do?',
            options: ['Stores a value under a name', 'Draws on screen', 'Connects to the internet', 'Compiles code'],
            correctIndex: 0,
            explanation: 'A variable is a named container for a value.',
          },
        ],
      },
    ],
    winCheck = {
      items: [
        {
          id: 'wc1',
          question: 'What does a variable do?',
          options: ['Stores a value', 'Draws on screen', 'Connects to net', 'Compiles code'],
          correctIndex: 0,
          explanation: 'A variable is a named container.',
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
    openerItems = [
      {
        id: 'opener-0',
        question: 'Quick recall: what is "variable"?',
        options: ['A named container for a value.', 'A kind of loop', 'A file format', 'A network protocol'],
        correctIndex: 0,
        explanation: 'A named container for a value.',
      },
    ],
    dossierId = 'dossier-test-id',
  } = overrides ?? {};

  return {
    id: 'lesson-test-id',
    trackId: 'track-test-id',
    seq: 1,
    spec: {},
    content: { blocks, winCheck, openerItems },
    citations: [],
    status: 'ready',
    verificationStatus: 'pending',
    faithfulnessScore: null,
    zpdSnapshot: { dossierId },
    workflowRunId: null,
    modelVersion: null,
    adminDismissedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as typeof s.lessons.$inferSelect;
}

const FAKE_TRACK_ROW = {
  ageBand: '16_17',
  displayName: 'Alice',
};

const FAKE_DOSSIER_ROW = {
  sources: [
    { url: 'https://docs.python.org/3/tutorial/index.html' },
    { url: 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps' },
  ],
  claims: [
    { claim: 'Variables store values under a name.', sourceUrls: ['https://docs.python.org/3/tutorial/index.html'] },
  ],
  misconceptions: ['Variables contain values rather than referencing them.'],
};

// ── env helpers ───────────────────────────────────────────────────────────────

let priorFake: string | undefined;
beforeEach(() => {
  priorFake = process.env.AI_FAKE_LLM;
  process.env.AI_FAKE_LLM = '1';
});
afterEach(() => {
  if (priorFake === undefined) delete process.env.AI_FAKE_LLM;
  else process.env.AI_FAKE_LLM = priorFake;
  vi.restoreAllMocks();
  vi.resetModules();
});

// ── 1. Fixture end-to-end: same input → same output twice ────────────────────

describe('sanitizeLessonContent — fixture end-to-end stable', () => {
  it('produces the same result on two consecutive calls (deterministic fixture)', async () => {
    const lesson = makeLessonRow();

    // Use separate db instances per call: makeMockDb has a queryDepth counter per instance.
    const db1 = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });
    const db2 = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });

    const result1 = await sanitizeLessonContent(db1, lesson);
    const result2 = await sanitizeLessonContent(db2, lesson);

    expect(JSON.stringify(result1.content)).toBe(JSON.stringify(result2.content));
    expect(result1.dropped).toEqual(result2.dropped);
    expect(result1.rewritten).toEqual(result2.rewritten);
  });

  it('sanitized content parses against lessonContentSchema', async () => {
    const db = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });
    const lesson = makeLessonRow();
    const result = await sanitizeLessonContent(db, lesson);
    const { lessonContentSchema } = await import('./blocks');
    // content has no openerItems — that is intentional; parse just blocks + winCheck
    expect(() => {
      lessonContentSchema.parse(result.content);
    }).not.toThrow();
  });
});

// ── 2. openerItems dropped before LLM ────────────────────────────────────────

describe('sanitizeLessonContent — openerItems dropped deterministically before LLM', () => {
  it('openerItems are absent from the sanitized content', async () => {
    const db = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });
    const lesson = makeLessonRow({
      openerItems: [
        {
          id: 'opener-0',
          question: 'Quick recall: what is "variable"?',
          options: ['A named container for a value.', 'A kind of loop', 'A file format', 'A network protocol'],
          correctIndex: 0,
          explanation: 'A named container for a value.',
        },
      ],
    });
    const result = await sanitizeLessonContent(db, lesson);
    // openerItems must not appear in the sanitized content
    expect('openerItems' in result.content).toBe(false);
    const serialized = JSON.stringify(result.content);
    expect(serialized).not.toContain('opener-0');
    expect(serialized).not.toContain('Quick recall:');
  });

  it('zero sanitize-block LLM calls for opener items (spy proves it)', async () => {
    // We verify the ordering guarantee: openerItems are dropped BEFORE the LLM loop.
    // Strategy: spy on the ai module's llmObject and count sanitize-block calls.
    // With AI_FAKE_LLM=1 the module path is different, so we set AI_FAKE_LLM=0
    // and use a mock for llmObject directly.
    process.env.AI_FAKE_LLM = '0';
    vi.resetModules();

    const llmCalls: Array<{ purpose: string; prompt: string }> = [];

    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockImplementation(
        async (opts: { purpose: string; prompt: string; schema: import('zod').ZodTypeAny }) => {
          llmCalls.push({ purpose: opts.purpose, prompt: opts.prompt });
          // Return a valid 'keep' response for sanitize-block calls
          if (opts.purpose === 'sanitize-block') {
            return opts.schema.parse({
              action: 'keep',
              reason: 'Block is fully generic.',
            });
          }
          // moderation: allowed
          if (opts.purpose === 'moderation') {
            return opts.schema.parse({ allowed: true, reason: 'ok' });
          }
          throw new Error(`Unexpected purpose: ${opts.purpose}`);
        },
      ),
    }));

    const { sanitizeLessonContent: sanitize } = await import('./sanitize');

    const openerItems = [
      {
        id: 'opener-0',
        question: 'Quick recall: what is "variable"?',
        options: ['A named container for a value.', 'A kind of loop', 'A file format', 'A network protocol'],
        correctIndex: 0,
        explanation: 'A named container for a value.',
      },
    ];

    const lesson = makeLessonRow({ openerItems });
    const db = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });

    await sanitize(db, lesson);

    // No sanitize-block call should have an opener in the prompt
    const sanitizeCalls = llmCalls.filter((c) => c.purpose === 'sanitize-block');
    const openerCallCount = sanitizeCalls.filter(
      (c) => c.prompt.includes('opener-0') || c.prompt.includes('Quick recall:'),
    ).length;
    expect(openerCallCount).toBe(0);

    // Number of sanitize-block calls should equal the number of body blocks (not including openers)
    // The lesson has 2 body blocks (article + quiz)
    expect(sanitizeCalls.length).toBe(2);
  });
});

// ── 3. Article rewritten ≠ original text but citations preserved ──────────────

describe('sanitizeLessonContent — article rewrite (citations preserved)', () => {
  it('rewritten article text differs from original personalised text', async () => {
    const db = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });
    const originalMarkdown =
      'Since you want to build a CLI tool, understanding variables will help you. ' +
      'Since you saw loops last lesson, variables are the next step.';
    const lesson = makeLessonRow({
      blocks: [
        {
          type: 'article',
          heading: 'Variables: names for values',
          markdown: originalMarkdown,
          citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
        },
        {
          type: 'quiz',
          items: [
            {
              id: 'q1',
              question: 'What does a variable do?',
              options: ['Stores a value', 'Draws on screen', 'Connects to net', 'Compiles code'],
              correctIndex: 0,
              explanation: 'A variable stores a value under a name.',
            },
          ],
        },
      ],
    });

    const result = await sanitizeLessonContent(db, lesson);

    // Article should have been rewritten
    expect(result.rewritten).toContain('article');

    // The rewritten article block should have different markdown
    const articleBlock = result.content.blocks.find((b) => b.type === 'article');
    expect(articleBlock).toBeDefined();
    if (articleBlock?.type === 'article') {
      expect(articleBlock.markdown).not.toBe(originalMarkdown);
      // Citations must be preserved from the original block
      expect(articleBlock.citationUrls).toContain('https://docs.python.org/3/tutorial/index.html');
    }
  });

  it('rewritten article has a non-empty heading', async () => {
    const db = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });
    const lesson = makeLessonRow();
    const result = await sanitizeLessonContent(db, lesson);
    const articleBlock = result.content.blocks.find((b) => b.type === 'article');
    if (articleBlock?.type === 'article') {
      expect(articleBlock.heading.length).toBeGreaterThan(0);
    }
  });
});

// ── 4. Malformed rewrite → dropped ───────────────────────────────────────────

describe('sanitizeLessonContent — malformed rewrite treated as drop', () => {
  it('a rewrite response violating the block schema causes the block to be dropped', async () => {
    process.env.AI_FAKE_LLM = '0';
    vi.resetModules();

    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockImplementation(
        async (opts: { purpose: string; schema: import('zod').ZodTypeAny }) => {
          if (opts.purpose === 'sanitize-block') {
            // Return a 'rewrite' with a block that violates lessonBlockSchema:
            // missing required 'heading' field and 'citationUrls'.
            return opts.schema.parse({
              action: 'rewrite',
              block: {
                // INVALID: missing type discriminator field entirely, will fail lessonBlockSchema
                type: 'article',
                // heading is missing — invalid for articleBlockSchema (min 3 chars)
                heading: 'xy', // too short — violates min(3)
                markdown: 'x'.repeat(50),
                citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
              },
              reason: 'Rewriting block.',
            });
          }
          if (opts.purpose === 'moderation') {
            return opts.schema.parse({ allowed: true, reason: 'ok' });
          }
          throw new Error(`Unexpected purpose: ${opts.purpose}`);
        },
      ),
    }));

    const { sanitizeLessonContent: sanitize } = await import('./sanitize');
    const db = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });
    const lesson = makeLessonRow({
      blocks: [
        {
          type: 'article',
          heading: 'Variables: names for values',
          markdown:
            'Since you want to build a CLI, variables are key. ' +
            'As you saw last lesson, each step builds on the next.',
          citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
        },
        {
          type: 'quiz',
          items: [
            {
              id: 'q1',
              question: 'What does a variable do?',
              options: ['Stores a value', 'Draws on screen', 'Connects to net', 'Compiles code'],
              correctIndex: 0,
              explanation: 'A variable stores a value under a name.',
            },
          ],
        },
      ],
    });

    // The article block will be malformed-rewritten → dropped (ZodError caught in loop).
    // Only quiz remains → validateLessonContent fails (no article block) → SanitizeError.
    // Note: vi.resetModules() causes module identity mismatch — check by name.
    let threw = false;
    try {
      await sanitize(db, lesson);
    } catch (e) {
      threw = true;
      expect((e as Error).name).toBe('SanitizeError');
    }
    expect(threw).toBe(true);
  });

  it('a rewrite with block=undefined is treated as drop', async () => {
    process.env.AI_FAKE_LLM = '0';
    vi.resetModules();

    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockImplementation(
        async (opts: { purpose: string; schema: import('zod').ZodTypeAny }) => {
          if (opts.purpose === 'sanitize-block') {
            // 'rewrite' with no block field — treated as drop
            return opts.schema.parse({
              action: 'rewrite',
              // block intentionally omitted
              reason: 'Block rewritten.',
            });
          }
          if (opts.purpose === 'moderation') {
            return opts.schema.parse({ allowed: true, reason: 'ok' });
          }
          throw new Error(`Unexpected purpose: ${opts.purpose}`);
        },
      ),
    }));

    const { sanitizeLessonContent: sanitize } = await import('./sanitize');
    const db = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });
    const lesson = makeLessonRow({
      blocks: [
        {
          type: 'article',
          heading: 'Variables: names for values',
          markdown: 'Since you want to build a CLI, variables are key. More text here to be above minimum.',
          citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
        },
        {
          type: 'quiz',
          items: [
            {
              id: 'q1',
              question: 'What does a variable do?',
              options: ['Stores a value', 'Draws on screen', 'Connects to net', 'Compiles code'],
              correctIndex: 0,
              explanation: 'A variable stores a value under a name.',
            },
          ],
        },
      ],
    });

    // Article dropped → fails validation (no article block) → SanitizeError
    // Note: vi.resetModules() causes module identity mismatch — check by name.
    let threw = false;
    try {
      await sanitize(db, lesson);
    } catch (e) {
      threw = true;
      expect((e as Error).name).toBe('SanitizeError');
    }
    expect(threw).toBe(true);
  });
});

// ── 5. assertNoLearnerLeak unit tests ─────────────────────────────────────────

describe('assertNoLearnerLeak — direct unit tests', () => {
  const makeContent = (markdown: string): Omit<LessonContent, 'openerItems'> => ({
    blocks: [
      {
        type: 'article' as const,
        heading: 'Test block',
        markdown,
        citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
      },
      {
        type: 'quiz' as const,
        items: [
          {
            id: 'q1',
            question: 'What does a variable do?',
            options: ['Stores a value', 'B', 'C', 'D'],
            correctIndex: 0 as const,
            explanation: 'A variable stores a value.',
          },
        ],
      },
    ],
    winCheck: {
      items: [
        {
          id: 'wc1',
          question: 'What does a variable do?',
          options: ['Stores a value', 'B', 'C', 'D'],
          correctIndex: 0 as const,
          explanation: 'A variable stores a value.',
        },
        {
          id: 'wc2',
          question: 'After x=5 then x=7, what is x?',
          options: ['7', '5', '12', 'Both'],
          correctIndex: 0 as const,
          explanation: 'Assignment replaces the value.',
        },
      ],
    },
  });

  it('throws SanitizeError when displayName appears in article markdown', () => {
    const content = makeContent('Alice uses variables to store values in her programs.');
    expect(() => assertNoLearnerLeak(content, 'Alice')).toThrow(SanitizeError);
  });

  it('throws when displayName appears in a nested field (e.g. quiz question)', () => {
    const content = makeContent('Variables store values under names.');
    // Inject the name into a quiz question
    content.blocks[1] = {
      type: 'quiz',
      items: [
        {
          id: 'q1',
          question: 'What did Alice learn about variables?',
          options: ['Stores a value', 'B', 'C', 'D'],
          correctIndex: 0 as const,
          explanation: 'A variable stores a value.',
        },
      ],
    };
    expect(() => assertNoLearnerLeak(content, 'Alice')).toThrow(SanitizeError);
  });

  it('throws when displayName appears in a winCheck item', () => {
    const content = makeContent('Variables store values under names.');
    content.winCheck.items[0] = {
      id: 'wc1',
      question: 'Alice studied variables — what do they do?',
      options: ['Stores a value', 'B', 'C', 'D'],
      correctIndex: 0 as const,
      explanation: 'A variable stores a value.',
    };
    expect(() => assertNoLearnerLeak(content, 'Alice')).toThrow(SanitizeError);
  });

  it('SanitizeError from leak guard is not retryable', () => {
    const content = makeContent('Alice uses variables.');
    try {
      assertNoLearnerLeak(content, 'Alice');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SanitizeError);
      expect((e as SanitizeError).retryable).toBe(false);
    }
  });

  it('is case-insensitive: "alice" matches displayName "Alice"', () => {
    const content = makeContent('alice uses variables to store values in programs.');
    expect(() => assertNoLearnerLeak(content, 'Alice')).toThrow(SanitizeError);
  });

  it('is case-insensitive: "ALICE" matches displayName "Alice"', () => {
    const content = makeContent('ALICE uses variables to store values in programs.');
    expect(() => assertNoLearnerLeak(content, 'Alice')).toThrow(SanitizeError);
  });

  it('conservative: name embedded inside a longer word still throws', () => {
    // "Alice" appears inside "Malice" — conservative policy throws.
    // This errs toward safety over false-negative privacy leaks.
    const content = makeContent('Without Malice, variables store values simply.');
    expect(() => assertNoLearnerLeak(content, 'Alice')).toThrow(SanitizeError);
  });

  it('does NOT throw when displayName is absent from content', () => {
    const content = makeContent('A variable is a named container for a value.');
    expect(() => assertNoLearnerLeak(content, 'Alice')).not.toThrow();
  });

  it('does NOT throw when displayName is empty string', () => {
    const content = makeContent('A variable is a named container for a value.');
    // Empty displayName should not match anything
    expect(() => assertNoLearnerLeak(content, '')).not.toThrow();
  });

  it('throws when name appears in a flashcard_deck', () => {
    const content = makeContent('A variable stores values.');
    content.blocks.push({
      type: 'flashcard_deck' as const,
      cards: [
        { front: "Alice's question: what is a variable?", back: 'A named container.' },
        { front: 'What does assignment do?', back: 'Stores a value.' },
      ],
    });
    expect(() => assertNoLearnerLeak(content, 'Alice')).toThrow(SanitizeError);
  });
});

// ── 6. validateLessonContent requireOpeners option ────────────────────────────

describe('validateLessonContent — requireOpeners option', () => {
  const makeValidContent = () => ({
    blocks: [
      {
        type: 'article' as const,
        heading: 'Variables: names for values',
        markdown:
          'A **variable** stores a value under a name so your program can use it later. ' +
          'Think of it as a labeled box: count = 3 puts the value 3 in a box labeled count. ' +
          'Variables let the same code work with different values.',
        citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
      },
      {
        type: 'quiz' as const,
        items: [
          {
            id: 'q1',
            question: 'After count = 3, what does reading count give you?',
            options: ['3', 'The text "count"', 'Nothing', 'An error'],
            correctIndex: 0 as const,
            explanation: 'The name count refers to the value stored in it — 3.',
          },
        ],
      },
    ],
    winCheck: {
      items: [
        {
          id: 'wc1',
          question: 'What does a variable do?',
          options: ['Stores a value under a name', 'Draws on screen', 'Connects to the internet', 'Compiles code'],
          correctIndex: 0 as const,
          explanation: 'A variable is a named container for a value.',
        },
        {
          id: 'wc2',
          question: 'After x = 5 then x = 7, what is x?',
          options: ['7', '5', '12', 'Both 5 and 7'],
          correctIndex: 0 as const,
          explanation: 'Assignment replaces the stored value.',
        },
      ],
    },
  });

  const DOSSIER_SOURCE_URLS = ['https://docs.python.org/3/tutorial/index.html'];

  it('requireOpeners defaults to true — existing valid content still passes', () => {
    // The default should not break any existing content — existing callers do not pass
    // openerItems (they use Omit<LessonContent, 'openerItems'>), and the validator must
    // continue to pass on valid content without the requireOpeners option.
    const result = validateLessonContent({
      content: makeValidContent(),
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('requireOpeners: false passes on sanitized content (no openers by design)', () => {
    // Sanitized content intentionally has no openerItems — the validator should still pass.
    const result = validateLessonContent({
      content: makeValidContent(),
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      requireOpeners: false,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('requireOpeners: true (explicit) passes on valid content', () => {
    const result = validateLessonContent({
      content: makeValidContent(),
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      requireOpeners: true,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── 7. Moderation flagged/errored → SanitizeError ────────────────────────────

describe('sanitizeLessonContent — moderation failures → SanitizeError', () => {
  it('moderation flagged → SanitizeError with retryable=false', async () => {
    process.env.AI_FAKE_LLM = '0';
    vi.resetModules();

    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockImplementation(
        async (opts: { purpose: string; schema: import('zod').ZodTypeAny }) => {
          if (opts.purpose === 'sanitize-block') {
            return opts.schema.parse({ action: 'keep', reason: 'Generic content.' });
          }
          if (opts.purpose === 'moderation') {
            // Flag the content — not allowed
            return opts.schema.parse({ allowed: false, reason: 'Flagged by moderation.' });
          }
          throw new Error(`Unexpected purpose: ${opts.purpose}`);
        },
      ),
    }));

    const { sanitizeLessonContent: sanitize } = await import('./sanitize');
    const db = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });
    const lesson = makeLessonRow();

    // Note: vi.resetModules() causes the SanitizeError class from the re-imported module
    // to be a different object than the one imported at the top of the file. We check by
    // name and shape instead of instanceof to avoid false negative from module identity mismatch.
    try {
      await sanitize(db, lesson);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).name).toBe('SanitizeError');
      expect((e as { retryable: boolean }).retryable).toBe(false);
    }
  });

  it('moderation errored → SanitizeError with retryable=true', async () => {
    process.env.AI_FAKE_LLM = '0';
    vi.resetModules();

    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockImplementation(
        async (opts: { purpose: string; schema: import('zod').ZodTypeAny }) => {
          if (opts.purpose === 'sanitize-block') {
            return opts.schema.parse({ action: 'keep', reason: 'Generic content.' });
          }
          throw new Error(`Unexpected purpose: ${opts.purpose}`);
        },
      ),
    }));

    // Override moderateText to return errored=true (different code path from flagged)
    vi.doMock('@/server/moderation', () => ({
      moderateText: vi.fn().mockResolvedValue({
        allowed: false,
        reason: 'moderation unavailable',
        errored: true,
      }),
    }));

    const { sanitizeLessonContent: sanitize } = await import('./sanitize');
    const db = makeMockDb({ trackRow: FAKE_TRACK_ROW, dossierRow: FAKE_DOSSIER_ROW });
    const lesson = makeLessonRow();

    // Note: vi.resetModules() causes module identity mismatch — check by name, not instanceof.
    try {
      await sanitize(db, lesson);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).name).toBe('SanitizeError');
      expect((e as { retryable: boolean }).retryable).toBe(true);
    }
  });

  it('moderation flagged vs errored: retryable distinguishable', async () => {
    // Verify the two error types produce different retryable flags.
    const flaggedError = new SanitizeError('flagged', { retryable: false });
    const erroredError = new SanitizeError('service unavailable', { retryable: true });

    expect(flaggedError.retryable).toBe(false);
    expect(erroredError.retryable).toBe(true);
    expect(flaggedError.retryable).not.toBe(erroredError.retryable);
  });
});
