/**
 * Tests for the llm-schema helper module and all converted LLM output schemas.
 *
 * Three levels:
 * (a) For EACH converted schema: over-long free-text parses and is truncated to the cap.
 * (b) Structural-strictness control: out-of-range score / wrong enum still REJECTS.
 * (c) Existing fixture-length text passes through unchanged (truncation no-ops).
 */

import { describe, it, expect } from 'vitest';
import { llmText, llmTextRequired, llmArrayMax } from './llm-schema';

// Import schemas directly from the modules under test
import { moderationSchema } from '@/server/moderation';
import {
  quizItemSchema,
  articleBlockSchema,
  glossaryCalloutSchema,
  flashcardDeckSchema,
  workedExampleSchema,
  animatedDiagramSchema,
  lessonPlanSchema,
} from '@/server/lessons/blocks';
import { distillRecordSchema, distillOutputSchema, createReferenceDocSchema } from '@/server/lessons/distiller';
import { skillGraphSchema, calibrationQuizSchema } from '@/server/track-init';
import { extractionSchema } from '@/server/research/extract';
import { vetSchema } from '@/server/research/trust';

// ── Helper: generate a string of exactly N chars ─────────────────────────────
const repeat = (n: number, ch = 'x') => ch.repeat(n);

// ══════════════════════════════════════════════════════════════════════════════
// Section A: llmText / llmTextRequired / llmArrayMax helpers
// ══════════════════════════════════════════════════════════════════════════════

describe('llmText', () => {
  it('passes text at exactly the cap', () => {
    const schema = llmText(10);
    expect(schema.parse(repeat(10))).toBe(repeat(10));
  });

  it('truncates text that exceeds the cap', () => {
    const schema = llmText(10);
    const result = schema.parse(repeat(20));
    expect(result).toHaveLength(10);
    expect(result).toBe(repeat(10));
  });

  it('passes text shorter than the cap unchanged', () => {
    const schema = llmText(100);
    expect(schema.parse('hello')).toBe('hello');
  });

  it('accepts an empty string (no min floor)', () => {
    const schema = llmText(10);
    expect(schema.parse('')).toBe('');
  });
});

describe('llmTextRequired', () => {
  it('truncates text that exceeds the max', () => {
    const schema = llmTextRequired(1, 10);
    const result = schema.parse(repeat(25));
    expect(result).toHaveLength(10);
  });

  it('rejects empty string (min floor is structural)', () => {
    const schema = llmTextRequired(1, 100);
    expect(() => schema.parse('')).toThrow();
  });

  it('rejects string shorter than min', () => {
    const schema = llmTextRequired(5, 100);
    expect(() => schema.parse('abc')).toThrow();
  });

  it('passes text in range unchanged', () => {
    const schema = llmTextRequired(1, 100);
    expect(schema.parse('hello')).toBe('hello');
  });
});

describe('llmArrayMax', () => {
  const schema = llmArrayMax(llmText(10), 3);

  it('passes an array within the limit', () => {
    expect(schema.parse(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('slices an over-long array to max', () => {
    const result = schema.parse(['a', 'b', 'c', 'd', 'e']);
    expect(result).toHaveLength(3);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('passes an empty array', () => {
    expect(schema.parse([])).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Section B: per-schema truncation + structural strictness
// ══════════════════════════════════════════════════════════════════════════════

// ── Moderation ────────────────────────────────────────────────────────────────
describe('moderationSchema (moderation purpose)', () => {
  it('truncates reason > 200 chars', () => {
    const result = moderationSchema.parse({ allowed: true, reason: repeat(330) });
    expect(result.reason).toHaveLength(200);
  });

  it('passes reason ≤ 200 chars unchanged', () => {
    const result = moderationSchema.parse({ allowed: true, reason: 'educational topic' });
    expect(result.reason).toBe('educational topic');
  });

  it('STRICT: rejects non-boolean allowed', () => {
    expect(() => moderationSchema.parse({ allowed: 'yes', reason: 'ok' })).toThrow();
  });
});

// ── vet-sources ───────────────────────────────────────────────────────────────
describe('vetSchema (vet-sources purpose)', () => {
  const validVerdict = { url: 'https://example.com', trusted: true, reason: 'ok' };

  it('truncates reason > 200 chars', () => {
    const result = vetSchema.parse({ verdicts: [{ ...validVerdict, reason: repeat(300) }] });
    expect(result.verdicts[0].reason).toHaveLength(200);
  });

  it('passes reason ≤ 200 chars unchanged', () => {
    const result = vetSchema.parse({ verdicts: [validVerdict] });
    expect(result.verdicts[0].reason).toBe('ok');
  });

  it('STRICT: rejects non-boolean trusted', () => {
    expect(() => vetSchema.parse({ verdicts: [{ ...validVerdict, trusted: 'yes' }] })).toThrow();
  });
});

// ── extract-source ────────────────────────────────────────────────────────────
describe('extractionSchema (extract-source purpose)', () => {
  const minClaim = { claim: repeat(8), quote: 'short quote' };

  it('truncates claim > 400 chars', () => {
    const result = extractionSchema.parse({ claims: [{ claim: repeat(500), quote: 'q' }], glossarySeeds: [], misconceptions: [] });
    expect(result.claims[0].claim).toHaveLength(400);
  });

  it('truncates quote > 600 chars', () => {
    const result = extractionSchema.parse({ claims: [{ claim: 'valid claim text!!', quote: repeat(700) }], glossarySeeds: [], misconceptions: [] });
    expect(result.claims[0].quote).toHaveLength(600);
  });

  it('slices claims array to max 12', () => {
    const manyClaims = Array.from({ length: 15 }, (_, i) => ({ claim: `Claim ${i + 1} is a factual statement about something.`, quote: 'q' }));
    const result = extractionSchema.parse({ claims: manyClaims, glossarySeeds: [], misconceptions: [] });
    expect(result.claims).toHaveLength(12);
  });

  it('slices misconceptions array to max 5', () => {
    const manyMisconceptions = Array.from({ length: 8 }, (_, i) => `Misconception number ${i + 1} that students commonly have`);
    const result = extractionSchema.parse({ claims: [minClaim], glossarySeeds: [], misconceptions: manyMisconceptions });
    expect(result.misconceptions).toHaveLength(5);
  });

  it('STRICT: rejects claim shorter than 8 chars', () => {
    expect(() => extractionSchema.parse({ claims: [{ claim: 'short', quote: 'q' }], glossarySeeds: [], misconceptions: [] })).toThrow();
  });

  it('passes fixture-length data unchanged', () => {
    const result = extractionSchema.parse({
      claims: [{ claim: 'Variables store values under a name.', quote: 'Variables store values under a name.' }],
      glossarySeeds: [{ term: 'variable', definition: 'A named container for a value.' }],
      misconceptions: ['Variables contain values rather than referencing them.'],
    });
    expect(result.claims[0].claim).toBe('Variables store values under a name.');
  });
});

// ── quizItemSchema ────────────────────────────────────────────────────────────
describe('quizItemSchema (used in generate-lesson, plan-lesson, calibration-quiz)', () => {
  const validItem = {
    id: 'q1',
    question: 'What does a variable store?',
    options: ['A value under a name', 'Draws on screen', 'Connects to internet', 'Compiles code'],
    correctIndex: 0,
    explanation: 'A variable is a named container for a value.',
  };

  it('truncates question > 400 chars', () => {
    const result = quizItemSchema.parse({ ...validItem, question: repeat(500) });
    expect(result.question).toHaveLength(400);
  });

  it('truncates each option > 200 chars', () => {
    const result = quizItemSchema.parse({
      ...validItem,
      options: [repeat(250), 'b', 'c', 'd'],
    });
    expect(result.options[0]).toHaveLength(200);
    expect(result.options[1]).toBe('b');
  });

  it('truncates explanation > 500 chars', () => {
    const result = quizItemSchema.parse({ ...validItem, explanation: repeat(600) });
    expect(result.explanation).toHaveLength(500);
  });

  it('STRICT: rejects correctIndex 4 (out of range)', () => {
    expect(() => quizItemSchema.parse({ ...validItem, correctIndex: 4 })).toThrow();
  });

  it('STRICT: rejects correctIndex -1', () => {
    expect(() => quizItemSchema.parse({ ...validItem, correctIndex: -1 })).toThrow();
  });

  it('STRICT: rejects options with wrong length (not 4)', () => {
    expect(() => quizItemSchema.parse({ ...validItem, options: ['a', 'b', 'c'] })).toThrow();
  });

  it('passes fixture-length data unchanged', () => {
    const result = quizItemSchema.parse(validItem);
    expect(result.question).toBe('What does a variable store?');
    expect(result.correctIndex).toBe(0);
  });
});

// ── articleBlockSchema ─────────────────────────────────────────────────────────
describe('articleBlockSchema (generate-lesson, regenerate-block)', () => {
  const validArticle = {
    type: 'article' as const,
    heading: 'Variables: names for values',
    markdown: 'A **variable** stores a value under a name so your program can use it later.',
    citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
  };

  it('truncates heading > 120 chars', () => {
    const result = articleBlockSchema.parse({ ...validArticle, heading: repeat(150) });
    expect(result.heading).toHaveLength(120);
  });

  it('truncates markdown > 7000 chars', () => {
    const result = articleBlockSchema.parse({ ...validArticle, markdown: repeat(8000) });
    expect(result.markdown).toHaveLength(7000);
  });

  it('passes fixture-length data unchanged', () => {
    const result = articleBlockSchema.parse(validArticle);
    expect(result.heading).toBe('Variables: names for values');
    expect(result.markdown).toBe('A **variable** stores a value under a name so your program can use it later.');
  });
});

// ── glossaryCalloutSchema ─────────────────────────────────────────────────────
describe('glossaryCalloutSchema (generate-lesson)', () => {
  it('truncates definition > 300 chars', () => {
    const result = glossaryCalloutSchema.parse({ type: 'glossary_callout', term: 'variable', definition: repeat(400) });
    expect(result.definition).toHaveLength(300);
  });

  it('truncates term > 80 chars', () => {
    const result = glossaryCalloutSchema.parse({ type: 'glossary_callout', term: repeat(100), definition: 'A named container.' });
    expect(result.term).toHaveLength(80);
  });
});

// ── lessonPlanSchema ──────────────────────────────────────────────────────────
describe('lessonPlanSchema (plan-lesson)', () => {
  const validPlan = {
    objective: 'Declare and use variables to store values',
    format: 'article' as const,
    estimatedMinutes: 8,
    blockOutline: [
      { type: 'article' as const, focus: 'What a variable is and why programs need them' },
      { type: 'quiz' as const, focus: 'Predict the value stored after an assignment' },
    ],
  };

  it('truncates objective > 200 chars', () => {
    const result = lessonPlanSchema.parse({ ...validPlan, objective: repeat(300) });
    expect(result.objective).toHaveLength(200);
  });

  it('slices blockOutline to max 10', () => {
    const manyBlocks = Array.from({ length: 13 }, (_, i) => ({ type: 'article' as const, focus: `Section ${i + 1} focus text` }));
    const result = lessonPlanSchema.parse({ ...validPlan, blockOutline: manyBlocks });
    expect(result.blockOutline).toHaveLength(10);
  });

  it('STRICT: rejects format !== "article"', () => {
    expect(() => lessonPlanSchema.parse({ ...validPlan, format: 'video' })).toThrow();
  });

  it('STRICT: rejects estimatedMinutes > 15', () => {
    expect(() => lessonPlanSchema.parse({ ...validPlan, estimatedMinutes: 20 })).toThrow();
  });

  it('STRICT: rejects estimatedMinutes < 5', () => {
    expect(() => lessonPlanSchema.parse({ ...validPlan, estimatedMinutes: 3 })).toThrow();
  });

  it('STRICT: rejects unknown block type in outline', () => {
    expect(() =>
      lessonPlanSchema.parse({
        ...validPlan,
        blockOutline: [{ type: 'video', focus: 'something' }],
      })
    ).toThrow();
  });

  it('passes fixture-length data unchanged', () => {
    const result = lessonPlanSchema.parse(validPlan);
    expect(result.objective).toBe('Declare and use variables to store values');
    expect(result.format).toBe('article');
  });
});

// ── distillRecordSchema ───────────────────────────────────────────────────────
describe('distillRecordSchema (distill-records)', () => {
  const validRecord = {
    recordType: 'demonstrated_understanding' as const,
    title: 'Can use variables to store values',
    body: 'The learner correctly identified what a variable does and predicted reassignment result.',
  };

  it('truncates title > 120 chars', () => {
    const result = distillRecordSchema.parse({ ...validRecord, title: repeat(150) });
    expect(result.title).toHaveLength(120);
  });

  it('truncates body > 400 chars', () => {
    const result = distillRecordSchema.parse({ ...validRecord, body: repeat(500) });
    expect(result.body).toHaveLength(400);
  });

  it('truncates implications > 300 chars', () => {
    const result = distillRecordSchema.parse({ ...validRecord, implications: repeat(400) });
    expect(result.implications).toHaveLength(300);
  });

  it('STRICT: rejects unknown recordType', () => {
    expect(() => distillRecordSchema.parse({ ...validRecord, recordType: 'opinion' })).toThrow();
  });

  it('passes fixture-length data unchanged', () => {
    const result = distillRecordSchema.parse(validRecord);
    expect(result.recordType).toBe('demonstrated_understanding');
    expect(result.title).toBe('Can use variables to store values');
  });
});

// ── distillOutputSchema ───────────────────────────────────────────────────────
describe('distillOutputSchema array caps (distill-records)', () => {
  const record = {
    recordType: 'demonstrated_understanding' as const,
    title: 'Record title',
    body: 'Record body text that has some content here.',
  };
  const promo = { term: 'variable', definition: 'A named container.' };

  it('slices records to max 4', () => {
    const manyRecords = Array.from({ length: 6 }, () => record);
    const result = distillOutputSchema.parse({ records: manyRecords, glossaryPromotions: [] });
    expect(result.records).toHaveLength(4);
  });

  it('slices glossaryPromotions to max 4', () => {
    const manyPromos = Array.from({ length: 7 }, () => promo);
    const result = distillOutputSchema.parse({ records: [], glossaryPromotions: manyPromos });
    expect(result.glossaryPromotions).toHaveLength(4);
  });
});

// ── createReferenceDocSchema ──────────────────────────────────────────────────
describe('createReferenceDocSchema (create-reference-doc)', () => {
  const validDoc = {
    title: 'Variables and types',
    docType: 'cheat_sheet' as const,
    sections: [{ heading: 'What is a variable?', markdown: 'A **variable** is a named container for a value.' }],
  };

  it('truncates title > 120 chars', () => {
    const result = createReferenceDocSchema.parse({ ...validDoc, title: repeat(150) });
    expect(result.title).toHaveLength(120);
  });

  it('truncates section markdown > 2000 chars', () => {
    const result = createReferenceDocSchema.parse({
      ...validDoc,
      sections: [{ heading: 'Section', markdown: repeat(2500) }],
    });
    expect(result.sections[0].markdown).toHaveLength(2000);
  });

  it('slices sections to max 6', () => {
    const manySections = Array.from({ length: 9 }, (_, i) => ({ heading: `Section ${i + 1}`, markdown: 'Content here.' }));
    const result = createReferenceDocSchema.parse({ ...validDoc, sections: manySections });
    expect(result.sections).toHaveLength(6);
  });

  it('STRICT: rejects unknown docType', () => {
    expect(() => createReferenceDocSchema.parse({ ...validDoc, docType: 'unknown_type' })).toThrow();
  });

  it('passes fixture-length data unchanged', () => {
    const result = createReferenceDocSchema.parse(validDoc);
    expect(result.docType).toBe('cheat_sheet');
    expect(result.title).toBe('Variables and types');
  });
});

// ── skillGraphSchema ──────────────────────────────────────────────────────────
describe('skillGraphSchema (skill-graph)', () => {
  const makeNode = (i: number) => ({
    name: `Skill ${i}`,
    summary: `Summary for skill ${i}`,
    missionRelevance: 0.5,
  });
  const tenNodes = Array.from({ length: 10 }, (_, i) => makeNode(i + 1));

  it('truncates node name > 120 chars', () => {
    const result = skillGraphSchema.parse({
      nodes: [{ ...makeNode(1), name: repeat(150) }, ...Array.from({ length: 9 }, (_, i) => makeNode(i + 2))],
      edges: [],
    });
    expect(result.nodes[0].name).toHaveLength(120);
  });

  it('truncates node summary > 300 chars', () => {
    const result = skillGraphSchema.parse({
      nodes: [{ ...makeNode(1), summary: repeat(400) }, ...Array.from({ length: 9 }, (_, i) => makeNode(i + 2))],
      edges: [],
    });
    expect(result.nodes[0].summary).toHaveLength(300);
  });

  it('STRICT: rejects missionRelevance > 1', () => {
    expect(() =>
      skillGraphSchema.parse({ nodes: [{ ...makeNode(1), missionRelevance: 1.5 }, ...Array.from({ length: 9 }, (_, i) => makeNode(i + 2))], edges: [] })
    ).toThrow();
  });

  it('STRICT: rejects fewer than 10 nodes', () => {
    expect(() =>
      skillGraphSchema.parse({ nodes: Array.from({ length: 5 }, (_, i) => makeNode(i + 1)), edges: [] })
    ).toThrow();
  });

  it('passes fixture-length data unchanged', () => {
    const result = skillGraphSchema.parse({ nodes: tenNodes, edges: [] });
    expect(result.nodes[0].name).toBe('Skill 1');
    expect(result.nodes[0].missionRelevance).toBe(0.5);
  });
});

// ── calibrationQuizSchema ─────────────────────────────────────────────────────
describe('calibrationQuizSchema (calibration-quiz)', () => {
  const validItem = {
    id: 'cal-1',
    question: 'What does a variable do in a program?',
    options: ['Stores a value under a name', 'Draws on the screen', 'Connects to the internet', 'Compiles the code'],
    correctIndex: 0,
    conceptName: 'Variables and types',
  };

  it('truncates question > 400 chars', () => {
    const result = calibrationQuizSchema.parse({ items: [{ ...validItem, question: repeat(500) }, { ...validItem, id: 'cal-2' }] });
    expect(result.items[0].question).toHaveLength(400);
  });

  it('truncates conceptName > 120 chars', () => {
    const result = calibrationQuizSchema.parse({ items: [{ ...validItem, conceptName: repeat(150) }, { ...validItem, id: 'cal-2' }] });
    expect(result.items[0].conceptName).toHaveLength(120);
  });

  it('STRICT: rejects correctIndex out of range', () => {
    expect(() =>
      calibrationQuizSchema.parse({ items: [{ ...validItem, correctIndex: 5 }, { ...validItem, id: 'cal-2' }] })
    ).toThrow();
  });

  it('STRICT: rejects options with wrong length', () => {
    expect(() =>
      calibrationQuizSchema.parse({ items: [{ ...validItem, options: ['a', 'b', 'c'] }, { ...validItem, id: 'cal-2' }] })
    ).toThrow();
  });

  it('STRICT: rejects fewer than 2 items', () => {
    expect(() => calibrationQuizSchema.parse({ items: [validItem] })).toThrow();
  });

  it('passes fixture-length data unchanged', () => {
    const result = calibrationQuizSchema.parse({ items: [validItem, { ...validItem, id: 'cal-2' }] });
    expect(result.items[0].question).toBe('What does a variable do in a program?');
    expect(result.items[0].correctIndex).toBe(0);
  });
});

// ── flashcardDeckSchema ───────────────────────────────────────────────────────
describe('flashcardDeckSchema (generate-lesson)', () => {
  const validDeck = {
    type: 'flashcard_deck' as const,
    cards: [
      { front: 'What is a variable?', back: 'A named container that stores a value.' },
      { front: 'What does assignment do?', back: 'It puts a value into a variable.' },
    ],
  };

  it('truncates card front > 300 chars', () => {
    const result = flashcardDeckSchema.parse({
      ...validDeck,
      cards: [{ front: repeat(400), back: 'back text' }, validDeck.cards[1]],
    });
    expect(result.cards[0].front).toHaveLength(300);
  });

  it('truncates card back > 500 chars', () => {
    const result = flashcardDeckSchema.parse({
      ...validDeck,
      cards: [{ front: 'front text', back: repeat(600) }, validDeck.cards[1]],
    });
    expect(result.cards[0].back).toHaveLength(500);
  });

  it('slices cards to max 12', () => {
    const manyCards = Array.from({ length: 15 }, (_, i) => ({ front: `Front ${i + 1}`, back: `Back ${i + 1}` }));
    const result = flashcardDeckSchema.parse({ ...validDeck, cards: manyCards });
    expect(result.cards).toHaveLength(12);
  });
});

// ── animatedDiagramSchema ─────────────────────────────────────────────────────
describe('animatedDiagramSchema (generate-lesson)', () => {
  const validDiagram = {
    type: 'animated_diagram' as const,
    title: 'Assignment flow: how a value moves into a variable',
    shapes: [
      { id: 'value-box', kind: 'box' as const, x: 5, y: 20, w: 22, h: 14, text: 'value: 5' },
      { id: 'assign-arrow', kind: 'arrow' as const, x: 28, y: 27, toX: 48, toY: 27 },
    ],
    steps: [
      { highlightIds: ['value-box'], caption: 'Start with the value 5.' },
      { highlightIds: ['assign-arrow'], caption: 'Copy 5 into the variable count.' },
    ],
  };

  it('truncates title > 120 chars', () => {
    const result = animatedDiagramSchema.parse({ ...validDiagram, title: repeat(150) });
    expect(result.title).toHaveLength(120);
  });

  it('truncates step caption > 300 chars', () => {
    const result = animatedDiagramSchema.parse({
      ...validDiagram,
      steps: [{ highlightIds: ['value-box'], caption: repeat(400) }, validDiagram.steps[1]],
    });
    expect(result.steps[0].caption).toHaveLength(300);
  });

  it('truncates shape text > 60 chars', () => {
    const result = animatedDiagramSchema.parse({
      ...validDiagram,
      shapes: [{ ...validDiagram.shapes[0], text: repeat(80) }, validDiagram.shapes[1]],
    });
    expect(result.shapes[0].text).toHaveLength(60);
  });

  it('STRICT: rejects unknown shape kind', () => {
    expect(() =>
      animatedDiagramSchema.parse({
        ...validDiagram,
        shapes: [{ id: 's1', kind: 'triangle', x: 10, y: 10 }, validDiagram.shapes[1]],
      })
    ).toThrow();
  });

  it('STRICT: rejects x > 100 (out of percentage range)', () => {
    expect(() =>
      animatedDiagramSchema.parse({
        ...validDiagram,
        shapes: [{ ...validDiagram.shapes[0], x: 110 }, validDiagram.shapes[1]],
      })
    ).toThrow();
  });
});

// ── workedExampleSchema ───────────────────────────────────────────────────────
describe('workedExampleSchema (generate-lesson)', () => {
  const validExample = {
    type: 'worked_example' as const,
    problem: 'Store then update a count: start at 5, then change it to 7.',
    steps: [
      { text: 'Write `count = 5` — creates a variable named count holding 5.' },
      { text: 'Write `count = 7` — replaces the stored value; count now holds 7.' },
    ],
    completionItem: {
      id: 'we1',
      question: 'After `count = 5` then `count = 7`, what does `count` hold?',
      options: ['count holds 7', 'count holds 5', 'count holds 12', 'count is undefined'],
      correctIndex: 0,
      explanation: 'Assignment overwrites the previous value — count now holds 7.',
    },
  };

  it('truncates problem > 600 chars', () => {
    const result = workedExampleSchema.parse({ ...validExample, problem: repeat(700) });
    expect(result.problem).toHaveLength(600);
  });

  it('truncates step text > 500 chars', () => {
    const result = workedExampleSchema.parse({
      ...validExample,
      steps: [{ text: repeat(600) }, validExample.steps[1]],
    });
    expect(result.steps[0].text).toHaveLength(500);
  });

  it('slices steps to max 8', () => {
    const manySteps = Array.from({ length: 10 }, (_, i) => ({ text: `Step ${i + 1} description with enough text` }));
    const result = workedExampleSchema.parse({ ...validExample, steps: manySteps });
    expect(result.steps).toHaveLength(8);
  });
});
