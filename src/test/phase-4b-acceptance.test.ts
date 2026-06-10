/**
 * Phase 4b Acceptance Suite
 *
 * Maps every Goal clause of Phase 4b to named assertions.
 * Thin wrappers over existing helpers — phase-goal-named titles per spec.
 *
 * Goal clauses:
 *   1. Lesson generation streams visible progress (outline-early UX)
 *   2. Lessons can contain FlashcardDeck, WorkedExample, AnimatedDiagram blocks
 *   3. Full 4-launch validator suite (readability, alias scan, correctIndex strip, sweeper)
 *
 * Integration tests use testDb (TEST_DATABASE_URL, port 5433).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { createLessonRow, stagePlan, stageGenerate, stageResearch, sweepStaleLessons } from '@/server/lessons/pipeline';
import { resolveStreamRunId } from '@/app/api/lessons/[lessonId]/stream/route';
import { stripContentAnswerKey } from '@/app/api/lessons/[lessonId]/route';
import { validateLessonContent } from '@/server/lessons/validate';
import { fleschKincaidGrade, stripMarkdown, READABILITY_BAND_TARGETS } from '@/server/lessons/readability';
import { lessonContentSchema } from '@/server/lessons/blocks';
import { fakeOutputs } from '@/lib/ai-fixtures';

// ── Seed helpers ───────────────────────────────────────────────────────────────

async function seedTrackWithNode(email: string) {
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
  await testDb.insert(s.skillNodes).values({
    trackId: track.id,
    name: 'Variables and types',
    summary: 'Declaring and using basic values',
    missionRelevance: 0.9,
  });
  await testDb.insert(s.trustDomains).values([
    { vertical: 'programming', domain: 'docs.python.org', tier: 'tier1', note: 'acceptance-test' },
    { vertical: 'programming', domain: 'developer.mozilla.org', tier: 'tier1', note: 'acceptance-test' },
    { vertical: 'programming', domain: 'realpython.com', tier: 'tier1', note: 'acceptance-test' },
  ]).onConflictDoNothing();
  return { userId: u.id, learnerId: learner.id, trackId: track.id };
}

async function seedMinimalTrack(email: string) {
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
    .values({ learnerId: learner.id, topic: 'Stream test topic', vertical: 'programming' })
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

/** Deep scan an object tree for any occurrence of correctIndex or explanation. */
function hasAnswerKey(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some(hasAnswerKey);
  const record = obj as Record<string, unknown>;
  if ('correctIndex' in record || 'explanation' in record) return true;
  return Object.values(record).some(hasAnswerKey);
}

// ── Shared setup ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
});
afterAll(() => testPool.end());

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 1: Lesson generation streams visible progress — outline-early UX
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 1 — streaming outline-early UX: spec persisted before content is ready', () => {
  it('goal-1: after stagePlan, spec contains objective and blockOutline (outline-early data available)', async () => {
    const { trackId } = await seedTrackWithNode('acceptance-spec-persist@t.dev');
    const lesson = await createLessonRow(testDb, trackId);

    const result = await stagePlan(testDb, lesson.id);
    expect(result.status).toBe('planned');

    const [updated] = await testDb
      .select({ spec: s.lessons.spec })
      .from(s.lessons)
      .where(eq(s.lessons.id, lesson.id));

    const spec = updated.spec as Record<string, unknown>;
    expect(typeof spec.objective).toBe('string');
    expect((spec.objective as string).length).toBeGreaterThan(0);
    expect(Array.isArray(spec.blockOutline)).toBe(true);
    expect((spec.blockOutline as unknown[]).length).toBeGreaterThan(0);
  });

  it('goal-1: stream-route guard returns 404 when lesson has no workflowRunId (run_not_started)', async () => {
    const { learnerId, trackId } = await seedMinimalTrack('acceptance-stream-no-runid@t.dev');
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'generating', zpdSnapshot: {} })
      .returning();

    const result = await resolveStreamRunId(testDb, lesson.id, learnerId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toBe('run_not_started');
    }
  });

  it('goal-1: stream-route guard returns 409 when lesson is already terminal (ready)', async () => {
    const { learnerId, trackId } = await seedMinimalTrack('acceptance-stream-terminal@t.dev');
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'ready' })
      .returning();

    const result = await resolveStreamRunId(testDb, lesson.id, learnerId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe('lesson_terminal');
    }
  });

  it('goal-1: stream-route guard returns ok + runId when generating lesson has workflowRunId', async () => {
    const { learnerId, trackId } = await seedMinimalTrack('acceptance-stream-ok@t.dev');
    const fakeRunId = 'run_acceptance_' + crypto.randomUUID();
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({
        trackId,
        seq: 1,
        spec: {},
        status: 'generating',
        zpdSnapshot: { workflowRunId: fakeRunId },
      })
      .returning();

    const result = await resolveStreamRunId(testDb, lesson.id, learnerId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.runId).toBe(fakeRunId);
  });

  it('goal-1: stream-route guard returns 404 when lessonId does not exist', async () => {
    const { learnerId } = await seedMinimalTrack('acceptance-stream-notfound@t.dev');
    const result = await resolveStreamRunId(testDb, crypto.randomUUID(), learnerId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 2: Lessons can contain FlashcardDeck, WorkedExample, AnimatedDiagram
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 2 — new block types: FlashcardDeck, WorkedExample, AnimatedDiagram in fixture', () => {
  it('goal-2: generate-lesson fixture parses against lessonContentSchema (all 7 block types present)', () => {
    const parsed = lessonContentSchema.safeParse(fakeOutputs['generate-lesson']);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const blocks = parsed.data.blocks;
    expect(blocks.some((b) => b.type === 'flashcard_deck')).toBe(true);
    expect(blocks.some((b) => b.type === 'worked_example')).toBe(true);
    expect(blocks.some((b) => b.type === 'animated_diagram')).toBe(true);
  });

  it('goal-2: flashcard_deck fixture block has 3 cards (variable/assignment/name)', () => {
    const parsed = lessonContentSchema.safeParse(fakeOutputs['generate-lesson']);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const deck = parsed.data.blocks.find((b) => b.type === 'flashcard_deck');
    expect(deck).toBeTruthy();
    if (!deck || deck.type !== 'flashcard_deck') return;
    expect(deck.cards).toHaveLength(3);
  });

  it('goal-2: worked_example fixture completionItem correct option is "count holds 7"', () => {
    const parsed = lessonContentSchema.safeParse(fakeOutputs['generate-lesson']);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const we = parsed.data.blocks.find((b) => b.type === 'worked_example');
    expect(we).toBeTruthy();
    if (!we || we.type !== 'worked_example') return;
    expect(we.completionItem.options[we.completionItem.correctIndex]).toBe('count holds 7');
  });

  it('goal-2: animated_diagram fixture has 3 shapes and 2 steps', () => {
    const parsed = lessonContentSchema.safeParse(fakeOutputs['generate-lesson']);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const diag = parsed.data.blocks.find((b) => b.type === 'animated_diagram');
    expect(diag).toBeTruthy();
    if (!diag || diag.type !== 'animated_diagram') return;
    expect(diag.shapes).toHaveLength(3);
    expect(diag.steps).toHaveLength(2);
  });

  it('goal-2: full pipeline delivers a ready lesson containing all 3 new block types', async () => {
    const { trackId } = await seedTrackWithNode('acceptance-pipeline-newblocks@t.dev');
    const lesson = await createLessonRow(testDb, trackId);

    await stagePlan(testDb, lesson.id);
    await stageResearch(testDb, lesson.id);
    const result = await stageGenerate(testDb, lesson.id);
    expect(result.status).toBe('ready');

    const [delivered] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    const parsed = lessonContentSchema.safeParse(delivered.content);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { blocks } = parsed.data;
    expect(blocks.some((b) => b.type === 'flashcard_deck')).toBe(true);
    expect(blocks.some((b) => b.type === 'worked_example')).toBe(true);
    expect(blocks.some((b) => b.type === 'animated_diagram')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 3a: Readability validator per age band
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 3a — readability validator: age-band gates enforce FK grade limits', () => {
  const DOSSIER_URLS = [
    'https://docs.python.org/3/tutorial/index.html',
    'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps',
  ];

  function makeSimpleContent(markdown: string) {
    return {
      blocks: [
        {
          type: 'article' as const,
          heading: 'Test article',
          markdown,
          citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
        },
        {
          type: 'quiz' as const,
          items: [
            {
              id: 'q1',
              question: 'What does a variable do in a program?',
              options: ['Stores a value', 'Draws on screen', 'Sends email', 'Compiles'],
              correctIndex: 0 as const,
              explanation: 'A variable stores a value under a name.',
            },
          ],
        },
      ],
      winCheck: {
        items: [
          {
            id: 'wc1',
            question: 'What does a variable do in a program?',
            options: ['Stores a value', 'Draws on screen', 'Sends email', 'Compiles'],
            correctIndex: 0 as const,
            explanation: 'A variable stores a value under a name.',
          },
          {
            id: 'wc2',
            question: 'What does assignment do in Python?',
            options: ['Stores a value', 'Prints output', 'Loops forever', 'Returns nothing'],
            correctIndex: 0 as const,
            explanation: 'Assignment stores a value in a variable.',
          },
        ],
      },
    };
  }

  it('goal-3a: fixture articles pass 18_plus readability gate (FK grade ≤14)', () => {
    const article1 = 'A variable stores a value under a name so your program can use it later. Think of it as a labeled box. Variables let the same code work with different values.';
    const grade = fleschKincaidGrade(stripMarkdown(article1));
    expect(grade).toBeLessThanOrEqual(READABILITY_BAND_TARGETS['18_plus']);
  });

  it('goal-3a: 13_15 band rejects unreadable article (synthetic grade-16 text)', () => {
    const hardText =
      'The comprehensive multifaceted ramifications of contemporary technological infrastructure advancements necessitate sophisticated interdisciplinary methodological frameworks for systematic evaluation. ' +
      'Consequently, practitioners confronting multitudinous organizational stakeholder requirements must demonstrate extraordinary proficiency in coordinating simultaneous computational architectures. ' +
      'Furthermore, the philosophical underpinnings undergirding epistemological frameworks necessitate continuous reexamination considering multidimensional transformational paradigmatic shifts. ' +
      'Notwithstanding aforementioned complexities, organizational representatives must comprehensively accommodate multidimensional institutional ramifications arising from aforementioned considerations.';

    const content = makeSimpleContent(hardText);
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_URLS,
      ageBand: '13_15',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('FK grade') && e.includes('worst sentences'))).toBe(true);
  });

  it('goal-3a: band constants are 13_15→9, 16_17→11, 18_plus→14', () => {
    expect(READABILITY_BAND_TARGETS['13_15']).toBe(9);
    expect(READABILITY_BAND_TARGETS['16_17']).toBe(11);
    expect(READABILITY_BAND_TARGETS['18_plus']).toBe(14);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 3b: Glossary alias scan
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 3b — glossary alias scan: case-insensitive whole-word detection', () => {
  const DOSSIER_URLS = ['https://docs.python.org/3/tutorial/index.html'];

  function makeContentWithArticle(markdown: string) {
    return {
      blocks: [
        {
          type: 'article' as const,
          heading: 'Variables',
          markdown,
          citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
        },
        {
          type: 'quiz' as const,
          items: [
            {
              id: 'q1',
              question: 'What does a variable store in a program?',
              options: ['A value', 'A screen', 'An email', 'A compile'],
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
            question: 'What does a variable do in a program?',
            options: ['Stores a value', 'Draws on screen', 'Sends email', 'Compiles'],
            correctIndex: 0 as const,
            explanation: 'A variable stores a value under a name.',
          },
          {
            id: 'wc2',
            question: 'What does assignment do?',
            options: ['Stores value', 'Prints output', 'Loops', 'Returns'],
            correctIndex: 0 as const,
            explanation: 'Assignment stores a value.',
          },
        ],
      },
    };
  }

  it('goal-3b: alias violation detected in article text (alias "var" of promoted term "variable")', () => {
    const content = makeContentWithArticle(
      'A var stores a value under a name. The var can hold any value.'
    );
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_URLS,
      glossaryAvoidAliases: [{ term: 'variable', aliases: ['var'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('"var"') && e.includes('"variable"'))).toBe(true);
  });

  it('goal-3b: whole-word match does not flag "variable" when alias is "var"', () => {
    const content = makeContentWithArticle(
      'A variable stores a value under a name. Variables are essential.'
    );
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_URLS,
      glossaryAvoidAliases: [{ term: 'variable', aliases: ['var'] }],
    });
    expect(result.errors.filter((e) => e.includes('"var"'))).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 3c: AnimatedDiagram structural validator
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 3c — animated_diagram validator: bad highlightId and arrow constraints', () => {
  const DOSSIER_URLS = [
    'https://docs.python.org/3/tutorial/index.html',
    'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps',
  ];

  function makeBaseContent() {
    return {
      blocks: [
        {
          type: 'article' as const,
          heading: 'Variables',
          markdown: 'A variable stores a value under a name. Variables are used everywhere in programming.',
          citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
        },
        {
          type: 'quiz' as const,
          items: [
            {
              id: 'q1',
              question: 'What does a variable store in a program?',
              options: ['A value', 'A screen', 'An email', 'A compile'],
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
            options: ['Stores a value', 'Draws on screen', 'Sends email', 'Compiles'],
            correctIndex: 0 as const,
            explanation: 'A variable stores a value under a name.',
          },
          {
            id: 'wc2',
            question: 'What does assignment do?',
            options: ['Stores value', 'Prints output', 'Loops', 'Returns'],
            correctIndex: 0 as const,
            explanation: 'Assignment stores a value.',
          },
        ],
      },
    };
  }

  it('goal-3c: bad highlightId (not in shapes) causes validation error', () => {
    const content = makeBaseContent();
    (content.blocks as unknown[]).push({
      type: 'animated_diagram',
      title: 'Assignment flow diagram',
      shapes: [
        { id: 'box-a', kind: 'box', x: 5, y: 20, w: 20, h: 12, text: 'value' },
        { id: 'box-b', kind: 'box', x: 47, y: 20, w: 22, h: 12, text: 'count' },
      ],
      steps: [
        { highlightIds: ['DOES-NOT-EXIST'], caption: 'Step one references unknown shape.' },
        { highlightIds: ['box-b'], caption: 'Step two highlights the variable box.' },
      ],
    });
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('DOES-NOT-EXIST'))).toBe(true);
  });

  it('goal-3c: arrow missing toX/toY causes validation error', () => {
    const content = makeBaseContent();
    (content.blocks as unknown[]).push({
      type: 'animated_diagram',
      title: 'Arrow flow diagram test',
      shapes: [
        { id: 'box-a', kind: 'box', x: 5, y: 20, w: 20, h: 12, text: 'value' },
        // arrow missing toX and toY — zod allows it (optional) but validator rejects it
        { id: 'arr', kind: 'arrow', x: 26, y: 26 },
        { id: 'box-b', kind: 'box', x: 47, y: 20, w: 22, h: 12, text: 'count' },
      ],
      steps: [
        { highlightIds: ['box-a'], caption: 'Start with the value on the right.' },
        { highlightIds: ['arr', 'box-b'], caption: 'Arrow copies value into count.' },
      ],
    });
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('arrow') && e.includes('missing toX or toY'))).toBe(true);
  });

  it('goal-3c: fixture diagram passes structural validation', () => {
    const parsed = lessonContentSchema.safeParse(fakeOutputs['generate-lesson']);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const synthDossier = fakeOutputs['synthesize-dossier'] as {
      claims: Array<{ claim: string; sourceUrls: string[] }>;
    };
    const dossierSourceUrls = [...new Set(synthDossier.claims.flatMap((c) => c.sourceUrls))];

    const result = validateLessonContent({ content: parsed.data, dossierSourceUrls });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 3d: GET strips correctIndex + explanation (no answer key in serialized shape)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 3d — GET strips answer key: correctIndex and explanation absent from serialized content', () => {
  function makeRichContent() {
    return {
      openerItems: [
        {
          id: 'opener-0',
          question: 'What is a variable in programming?',
          options: ['A named container', 'A loop', 'A function', 'A file'],
          correctIndex: 0,
          explanation: 'A variable is a named container for a value.',
        },
      ],
      blocks: [
        {
          type: 'article',
          heading: 'Variables',
          markdown: 'A variable stores a value under a name.',
          citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
        },
        {
          type: 'quiz',
          items: [
            {
              id: 'q1',
              question: 'What does count = 3 do in Python?',
              options: ['Stores 3', 'Prints 3', 'Deletes 3', 'None'],
              correctIndex: 0,
              explanation: 'count = 3 stores the value 3.',
            },
          ],
        },
        {
          type: 'worked_example',
          problem: 'Store then update a count starting at 5.',
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
            question: 'What does a variable do in a program?',
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

  it('goal-3d: stripContentAnswerKey removes ALL correctIndex and explanation fields (deep scan)', () => {
    const content = makeRichContent();
    const stripped = stripContentAnswerKey(content);
    expect(hasAnswerKey(stripped)).toBe(false);
  });

  it('goal-3d: stripped content preserves question, options, and id fields for client use', () => {
    const content = makeRichContent();
    const stripped = stripContentAnswerKey(content) as typeof content;

    // openerItems preserved
    expect(stripped.openerItems).toHaveLength(1);
    expect((stripped.openerItems[0] as Record<string, unknown>).question).toBeTruthy();

    // quiz block items preserved
    const quizBlock = stripped.blocks.find((b) => (b as Record<string, unknown>).type === 'quiz') as {
      type: 'quiz';
      items: Record<string, unknown>[];
    };
    expect(quizBlock.items[0].id).toBe('q1');

    // worked_example completionItem preserved
    const weBlock = stripped.blocks.find(
      (b) => (b as Record<string, unknown>).type === 'worked_example'
    ) as { type: 'worked_example'; completionItem: Record<string, unknown> };
    expect(weBlock.completionItem.id).toBe('we1');

    // winCheck items preserved
    expect((stripped.winCheck as { items: unknown[] }).items).toHaveLength(2);
  });

  it('goal-3d: stripContentAnswerKey is idempotent (stripping twice equals stripping once)', () => {
    const content = makeRichContent();
    const once = stripContentAnswerKey(content);
    const twice = stripContentAnswerKey(once);
    expect(hasAnswerKey(twice)).toBe(false);
    expect(JSON.stringify(once)).toEqual(JSON.stringify(twice));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 3e: Stale-generating sweeper reclaims stuck lessons
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 3e — stale-generating sweeper: qualifying lessons fail+refund; ready lessons untouched', () => {
  it('goal-3e: sweeper transitions a stale generating lesson to failed (negative olderThanMs — cutoff in future so any row qualifies)', async () => {
    const { trackId } = await seedMinimalTrack('acceptance-sweep-qualify@t.dev');

    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'generating' })
      .returning();

    // Use a negative threshold so the cutoff is in the FUTURE, making any newly-created row qualify.
    // (olderThanMs=0 → cutoff=now() → lt(updatedAt, now()) may be false for rows just created at now())
    const result = await sweepStaleLessons(testDb, trackId, -60_000);
    expect(result.swept).toBe(1);

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(row.status).toBe('failed');
  });

  it('goal-3e: sweeper does not touch ready lessons even with negative threshold', async () => {
    const { trackId } = await seedMinimalTrack('acceptance-sweep-ready@t.dev');

    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'ready' })
      .returning();

    const result = await sweepStaleLessons(testDb, trackId, -60_000);
    expect(result.swept).toBe(0);

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(row.status).toBe('ready');
  });

  it('goal-3e: injectable threshold — fresh row NOT swept when threshold exceeds its age', async () => {
    const { trackId } = await seedMinimalTrack('acceptance-sweep-threshold@t.dev');

    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: {}, status: 'generating' })
      .returning();

    // 15-minute threshold — fresh row is not old enough
    const result = await sweepStaleLessons(testDb, trackId, 15 * 60 * 1000);
    expect(result.swept).toBe(0);

    const [row] = await testDb.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));
    expect(row.status).toBe('generating');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal 3f: worked_example alone satisfies "≥1 graded interactive block" check
// ═══════════════════════════════════════════════════════════════════════════════

describe('Goal 3f — validator: worked_example alone satisfies graded-block requirement', () => {
  const DOSSIER_URLS = ['https://docs.python.org/3/tutorial/index.html'];

  it('goal-3f: content with worked_example (no quiz) passes graded-block check', () => {
    const content = {
      blocks: [
        {
          type: 'article' as const,
          heading: 'Variables in Python',
          markdown: 'A variable stores a value under a name. Variables are used everywhere in programming code.',
          citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
        },
        {
          type: 'worked_example' as const,
          problem: 'Store then update a count: start at 5, then change it to 7.',
          steps: [
            { text: 'Write `count = 5` — this creates a variable named count.' },
            { text: 'Write `count = 7` — assignment replaces the stored value.' },
          ],
          completionItem: {
            id: 'we-accept-1',
            question: 'After `count = 5` then `count = 7`, what does `count` hold?',
            options: ['count holds 7', 'count holds 5', 'count holds 12', 'count is undefined'],
            correctIndex: 0 as const,
            explanation: 'Assignment overwrites the previous value — count now holds 7.',
          },
        },
      ],
      winCheck: {
        items: [
          {
            id: 'wc1-accept',
            question: 'What does a variable do in a program?',
            options: ['Stores a value', 'Draws on screen', 'Sends email', 'Compiles'],
            correctIndex: 0 as const,
            explanation: 'A variable stores a value under a name.',
          },
          {
            id: 'wc2-accept',
            question: 'What does assignment do in Python?',
            options: ['Stores a value', 'Prints output', 'Loops forever', 'Returns nothing'],
            correctIndex: 0 as const,
            explanation: 'Assignment stores a value in a variable.',
          },
        ],
      },
    };

    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_URLS });
    expect(result.errors).not.toContain('no graded interactive block in body');
    expect(result.ok).toBe(true);
  });
});
