import { describe, it, expect } from 'vitest';
import { validateLessonContent } from './validate';
import type { LessonValidationInput } from './validate';
import type { animatedDiagramSchema } from './blocks';
import type { z } from 'zod';

type AnimatedDiagramBlock = z.infer<typeof animatedDiagramSchema>;

// Source URLs from the synthesize-dossier fixture (ai-fixtures.ts)
const DOSSIER_SOURCE_URLS = [
  'https://docs.python.org/3/tutorial/index.html',
  'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps',
  'https://realpython.com/command-line-interfaces-python-argparse/',
];

// ── helpers ───────────────────────────────────────────────────────────────────

function makeValidContent(): LessonValidationInput['content'] {
  return {
    blocks: [
      {
        type: 'article',
        heading: 'Variables: names for values',
        markdown:
          'A **variable** stores a value under a name so your program can use it later. Think of it as a labeled box: `count = 3` puts the value 3 in a box labeled count. When the program reads `count`, it finds 3. Variables let the same code work with different values — change what goes in the box, and everything that reads the label sees the new value. This is the first building block of every program you will write.',
        citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
      },
      { type: 'glossary_callout', term: 'variable', definition: 'A named container for a value.' },
      {
        type: 'quiz',
        items: [
          {
            id: 'q1',
            question: 'After `count = 3`, what does reading `count` give you?',
            options: ['3', 'The text "count"', 'Nothing', 'An error'],
            correctIndex: 0,
            explanation: 'The name count refers to the value stored in it — 3.',
          },
        ],
      },
      {
        type: 'article',
        heading: 'Choosing good names',
        markdown:
          'Names should say what the value MEANS: `user_count` beats `x`. Future-you reads code far more often than writes it, and clear names are the cheapest documentation there is. Most languages have conventions — follow what the codebase around you does.',
        citationUrls: ['https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps'],
      },
    ],
    winCheck: {
      items: [
        {
          id: 'wc1',
          question: 'What does a variable do?',
          options: ['Stores a value under a name', 'Draws on screen', 'Connects to the internet', 'Compiles code'],
          correctIndex: 0,
          explanation: 'A variable is a named container for a value.',
        },
        {
          id: 'wc2',
          question: 'After `x = 5` then `x = 7`, what is x?',
          options: ['7', '5', '12', 'Both 5 and 7'],
          correctIndex: 0,
          explanation: 'Assignment replaces the stored value — the box now holds 7.',
        },
      ],
    },
  };
}

// ── valid content passes ──────────────────────────────────────────────────────

describe('validateLessonContent — valid content', () => {
  it('returns ok: true with no errors for valid content', () => {
    const result = validateLessonContent({
      content: makeValidContent(),
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── missing article block ──────────────────────────────────────────────────────

describe('validateLessonContent — missing article', () => {
  it('fails with "no article block" when no article blocks present', () => {
    const content = makeValidContent();
    content.blocks = content.blocks.filter((b) => b.type !== 'article');
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('no article block');
  });
});

// ── missing quiz block ────────────────────────────────────────────────────────

describe('validateLessonContent — missing quiz', () => {
  it('fails with "no graded interactive block in body" when no quiz blocks present', () => {
    const content = makeValidContent();
    content.blocks = content.blocks.filter((b) => b.type !== 'quiz');
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('no graded interactive block in body');
  });

  it('passes "no graded interactive block" check when only a worked_example is present (no quiz)', () => {
    const content = makeValidContent();
    // Replace the quiz block with a worked_example
    content.blocks = content.blocks
      .filter((b) => b.type !== 'quiz')
      .concat([
        {
          type: 'worked_example',
          problem: 'Store then update a count: start at 5, then change it to 7.',
          steps: [
            { text: 'Write `count = 5` to create the variable.' },
            { text: 'Write `count = 7` to overwrite the value.' },
          ],
          completionItem: {
            id: 'we-test-1',
            question: 'After `count = 5` then `count = 7`, what does `count` hold?',
            options: ['count holds 7', 'count holds 5', 'count holds 12', 'count is undefined'],
            correctIndex: 0,
            explanation: 'Assignment overwrites the previous value — count now holds 7.',
          },
        },
      ]);
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    // Should NOT have "no graded interactive block in body"
    expect(result.errors).not.toContain('no graded interactive block in body');
    // Should still pass overall (the base content has article + citations)
    expect(result.ok).toBe(true);
  });

  it('fails when NEITHER quiz NOR worked_example blocks are present', () => {
    const content = makeValidContent();
    content.blocks = content.blocks.filter((b) => b.type !== 'quiz');
    // Ensure no worked_example either (makeValidContent only has quiz blocks, so just filtering is enough)
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('no graded interactive block in body');
  });
});

// ── unresolvable citations ────────────────────────────────────────────────────

describe('validateLessonContent — unresolvable citations', () => {
  it('fails when no citationUrl resolves to a dossier source', () => {
    const content = makeValidContent();
    // Replace the first article block's citations with a non-dossier URL
    const article = content.blocks.find((b) => b.type === 'article')!;
    if (article.type === 'article') {
      article.citationUrls = ['https://invented-source.example/fake'];
    }
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('no citation resolving to a dossier source'))).toBe(true);
  });

  it('passes when at least one citationUrl resolves to a dossier source', () => {
    const content = makeValidContent();
    const article = content.blocks.find((b) => b.type === 'article')!;
    if (article.type === 'article') {
      // Mix of dossier URL + fake URL — should pass because one resolves
      article.citationUrls = [
        'https://docs.python.org/3/tutorial/index.html',
        'https://invented-source.example/fake',
      ];
    }
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── duplicate item ids ────────────────────────────────────────────────────────

describe('validateLessonContent — duplicate item ids', () => {
  it('fails with "duplicate quiz item ids" when body quiz and win-check share an id', () => {
    const content = makeValidContent();
    // Set the body quiz item to the same id as a win-check item
    const quiz = content.blocks.find((b) => b.type === 'quiz')!;
    if (quiz.type === 'quiz') {
      quiz.items[0].id = 'wc1'; // collides with win-check item
    }
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('duplicate quiz item ids');
  });

  it('fails with "duplicate quiz item ids" when two body quiz items share an id', () => {
    const content = makeValidContent();
    const quiz = content.blocks.find((b) => b.type === 'quiz')!;
    if (quiz.type === 'quiz') {
      quiz.items.push({ ...quiz.items[0] }); // duplicate body item
    }
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('duplicate quiz item ids');
  });
});

// ── >9000 chars ───────────────────────────────────────────────────────────────

describe('validateLessonContent — character budget', () => {
  it('fails when total article markdown exceeds 9000 chars', () => {
    const content = makeValidContent();
    const article = content.blocks.find((b) => b.type === 'article')!;
    if (article.type === 'article') {
      article.markdown = 'x'.repeat(9001);
    }
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('exceeds the 5-15 minute budget proxy'))).toBe(true);
  });

  it('passes when total article markdown is exactly 9000 chars', () => {
    const content = makeValidContent();
    // Replace all articles with exactly one article of 9000 chars total
    const originalArticles = content.blocks.filter((b) => b.type === 'article');
    // Give first article 8900 chars, second article 100 chars
    if (originalArticles[0].type === 'article') originalArticles[0].markdown = 'x'.repeat(8900);
    if (originalArticles[1]?.type === 'article') originalArticles[1].markdown = 'y'.repeat(100);
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    // Should only fail on citation URL resolution for the replaced markdown, not the budget
    expect(result.errors.some((e) => e.includes('exceeds the 5-15 minute budget proxy'))).toBe(false);
  });
});

// ── flashcardDeckSchema bounds ────────────────────────────────────────────────

describe('flashcardDeckSchema — bounds', () => {
  it('accepts a valid flashcard_deck with 2 cards (min)', async () => {
    const { flashcardDeckSchema } = await import('./blocks');
    const result = flashcardDeckSchema.safeParse({
      type: 'flashcard_deck',
      cards: [
        { front: 'What is a variable?', back: 'A named container for a value.' },
        { front: 'What does assignment do?', back: 'It stores a value in a variable.' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects flashcard_deck with fewer than 2 cards', async () => {
    const { flashcardDeckSchema } = await import('./blocks');
    const result = flashcardDeckSchema.safeParse({
      type: 'flashcard_deck',
      cards: [{ front: 'Q', back: 'A' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts flashcard_deck with more than 12 cards and truncates to 12 (llmArrayMax)', async () => {
    const { flashcardDeckSchema } = await import('./blocks');
    const result = flashcardDeckSchema.safeParse({
      type: 'flashcard_deck',
      cards: Array.from({ length: 13 }, (_, i) => ({
        front: `Q${i + 1}`,
        back: `A${i + 1}`,
      })),
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cards).toHaveLength(12);
  });

  it('rejects a card with an empty front string', async () => {
    const { flashcardDeckSchema } = await import('./blocks');
    const result = flashcardDeckSchema.safeParse({
      type: 'flashcard_deck',
      cards: [
        { front: '', back: 'A named container for a value.' },
        { front: 'Q2', back: 'A2' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts and truncates a card front exceeding 300 chars (llmTextRequired)', async () => {
    const { flashcardDeckSchema } = await import('./blocks');
    const result = flashcardDeckSchema.safeParse({
      type: 'flashcard_deck',
      cards: [
        { front: 'x'.repeat(301), back: 'back text' },
        { front: 'Q2', back: 'A2' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cards[0].front).toHaveLength(300);
  });

  it('accepts and truncates a card back exceeding 500 chars (llmTextRequired)', async () => {
    const { flashcardDeckSchema } = await import('./blocks');
    const result = flashcardDeckSchema.safeParse({
      type: 'flashcard_deck',
      cards: [
        { front: 'front text', back: 'x'.repeat(501) },
        { front: 'Q2', back: 'A2' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cards[0].back).toHaveLength(500);
  });
});

// ── workedExampleSchema bounds ────────────────────────────────────────────────

describe('workedExampleSchema — bounds', () => {
  function makeValidWorkedExample() {
    return {
      type: 'worked_example' as const,
      problem: 'Store then update a count.',
      steps: [
        { text: 'Write `count = 5` to create the variable.' },
        { text: 'Write `count = 7` to overwrite the value.' },
      ],
      completionItem: {
        id: 'we1',
        question: 'After `count = 5` then `count = 7`, what does `count` hold?',
        options: ['count holds 7', 'count holds 5', 'count holds 12', 'count is undefined'],
        correctIndex: 0,
        explanation: 'Assignment overwrites the previous value — count now holds 7.',
      },
    };
  }

  it('accepts a valid worked_example', async () => {
    const { workedExampleSchema } = await import('./blocks');
    const result = workedExampleSchema.safeParse(makeValidWorkedExample());
    expect(result.success).toBe(true);
  });

  it('rejects worked_example with fewer than 2 steps', async () => {
    const { workedExampleSchema } = await import('./blocks');
    const data = makeValidWorkedExample();
    data.steps = [{ text: 'Only one step here.' }];
    const result = workedExampleSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts and truncates worked_example with more than 8 steps (llmArrayMax)', async () => {
    const { workedExampleSchema } = await import('./blocks');
    const data = makeValidWorkedExample();
    data.steps = Array.from({ length: 9 }, (_, i) => ({ text: `Step ${i + 1} has some text here.` }));
    const result = workedExampleSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.steps).toHaveLength(8);
  });

  it('rejects worked_example with a problem shorter than 8 chars', async () => {
    const { workedExampleSchema } = await import('./blocks');
    const data = makeValidWorkedExample();
    data.problem = 'Short';
    const result = workedExampleSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts and truncates a worked_example problem exceeding 600 chars (llmTextRequired)', async () => {
    const { workedExampleSchema } = await import('./blocks');
    const data = makeValidWorkedExample();
    data.problem = 'x'.repeat(601);
    const result = workedExampleSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.problem).toHaveLength(600);
  });

  it('rejects a step with text shorter than 8 chars', async () => {
    const { workedExampleSchema } = await import('./blocks');
    const data = makeValidWorkedExample();
    data.steps = [{ text: 'Short' }, { text: 'Valid step text here.' }];
    const result = workedExampleSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects worked_example without a completionItem', async () => {
    const { workedExampleSchema } = await import('./blocks');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = { ...makeValidWorkedExample() };
    delete data.completionItem;
    const result = workedExampleSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── worked_example completionItem id included in duplicate-id check ───────────

describe('validateLessonContent — worked_example completionItem id deduplication', () => {
  it('fails with "duplicate quiz item ids" when worked_example completionItem id collides with a win-check id', () => {
    const content = makeValidContent();
    content.blocks = content.blocks
      .filter((b) => b.type !== 'quiz')
      .concat([
        {
          type: 'worked_example',
          problem: 'Store then update a count.',
          steps: [
            { text: 'Write `count = 5` to create the variable.' },
            { text: 'Write `count = 7` to overwrite the value.' },
          ],
          completionItem: {
            id: 'wc1', // collides with win-check item id
            question: 'After `count = 5` then `count = 7`, what does `count` hold?',
            options: ['count holds 7', 'count holds 5', 'count holds 12', 'count is undefined'],
            correctIndex: 0,
            explanation: 'Assignment overwrites the previous value.',
          },
        },
      ]);
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('duplicate quiz item ids');
  });
});

// ── animatedDiagramSchema bounds ─────────────────────────────────────────────

describe('animatedDiagramSchema — bounds', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeValidDiagram(): any {
    return {
      type: 'animated_diagram',
      title: 'Assignment flow',
      shapes: [
        { id: 'box-a', kind: 'box', x: 5, y: 20, w: 20, h: 12, text: 'value: 5' },
        { id: 'arr', kind: 'arrow', x: 26, y: 26, toX: 46, toY: 26 },
        { id: 'box-b', kind: 'box', x: 47, y: 20, w: 22, h: 12, text: 'count' },
      ],
      steps: [
        { highlightIds: ['box-a'], caption: 'Start with the value on the right.' },
        { highlightIds: ['arr', 'box-b'], caption: 'Assignment copies the value into count.' },
      ],
    };
  }

  it('accepts a valid animated_diagram', async () => {
    const { animatedDiagramSchema } = await import('./blocks');
    const result = animatedDiagramSchema.safeParse(makeValidDiagram());
    expect(result.success).toBe(true);
  });

  it('rejects animated_diagram with fewer than 2 shapes', async () => {
    const { animatedDiagramSchema } = await import('./blocks');
    const data = makeValidDiagram();
    data.shapes = [{ id: 'box-a', kind: 'box', x: 5, y: 20, w: 20, h: 12, text: 'only one' }];
    const result = animatedDiagramSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects animated_diagram with more than 20 shapes', async () => {
    const { animatedDiagramSchema } = await import('./blocks');
    const data = makeValidDiagram();
    data.shapes = Array.from({ length: 21 }, (_, i) => ({
      id: `s${i}`,
      kind: 'box' as const,
      x: i * 4,
      y: 20,
      w: 10,
      h: 8,
    }));
    const result = animatedDiagramSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects animated_diagram with fewer than 2 steps', async () => {
    const { animatedDiagramSchema } = await import('./blocks');
    const data = makeValidDiagram();
    data.steps = [{ highlightIds: ['box-a'], caption: 'Only one step provided here.' }];
    const result = animatedDiagramSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects a step with an empty highlightIds array', async () => {
    const { animatedDiagramSchema } = await import('./blocks');
    const data = makeValidDiagram();
    data.steps[0] = { highlightIds: [], caption: 'No highlights but should fail.' };
    const result = animatedDiagramSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects a step with a caption shorter than 8 chars', async () => {
    const { animatedDiagramSchema } = await import('./blocks');
    const data = makeValidDiagram();
    data.steps[0] = { highlightIds: ['box-a'], caption: 'Short' };
    const result = animatedDiagramSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts and truncates a shape text exceeding 60 chars (llmText)', async () => {
    const { animatedDiagramSchema } = await import('./blocks');
    const data = makeValidDiagram();
    data.shapes[0] = { ...data.shapes[0], text: 'x'.repeat(61) };
    const result = animatedDiagramSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.shapes[0].text).toHaveLength(60);
  });

  it('rejects a shape id exceeding 40 chars', async () => {
    const { animatedDiagramSchema } = await import('./blocks');
    const data = makeValidDiagram();
    data.shapes[0] = { ...data.shapes[0], id: 'x'.repeat(41) };
    const result = animatedDiagramSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── validate.ts: animated_diagram structural rules ───────────────────────────

describe('validateLessonContent — animated_diagram rules', () => {
  // Reuse makeValidContent from top but swap in a diagram block
  function makeContentWithDiagram(diagramOverride?: Partial<AnimatedDiagramBlock>) {
    const base = makeValidContent();
    const diagram: AnimatedDiagramBlock = {
      type: 'animated_diagram',
      title: 'Assignment flow',
      shapes: [
        { id: 'box-a', kind: 'box', x: 5, y: 20, w: 20, h: 12, text: 'value: 5' },
        { id: 'arr', kind: 'arrow', x: 26, y: 26, toX: 46, toY: 26 },
        { id: 'box-b', kind: 'box', x: 47, y: 20, w: 22, h: 12, text: 'count' },
      ],
      steps: [
        { highlightIds: ['box-a'], caption: 'Start with the value on the right.' },
        { highlightIds: ['arr', 'box-b'], caption: 'Assignment copies the value into count.' },
      ],
      ...diagramOverride,
    };
    base.blocks = [...base.blocks, diagram];
    return base;
  }

  it('passes when all highlightIds reference known shape ids', () => {
    const result = validateLessonContent({
      content: makeContentWithDiagram(),
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when a step has a highlightId that does not match any shape id', () => {
    const content = makeContentWithDiagram({
      steps: [
        { highlightIds: ['box-a'], caption: 'Start with the value on the right.' },
        { highlightIds: ['UNKNOWN-ID'], caption: 'This highlight id does not exist here.' },
      ],
    });
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('UNKNOWN-ID'))).toBe(true);
    expect(result.errors.some((e) => e.includes('does not match any shape id'))).toBe(true);
  });

  it('fails when an arrow shape is missing toX', () => {
    const shapes: AnimatedDiagramBlock['shapes'] = [
      { id: 'box-a', kind: 'box', x: 5, y: 20, w: 20, h: 12, text: 'value' },
      // arrow missing toX and toY — satisfies zod schema (optional) but validator rejects it
      { id: 'arr', kind: 'arrow', x: 26, y: 26 },
      { id: 'box-b', kind: 'box', x: 47, y: 20, w: 22, h: 12, text: 'count' },
    ];
    const content = makeContentWithDiagram({ shapes });
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('arrow') && e.includes('missing toX or toY'))).toBe(true);
  });

  it('fails when a label shape is missing text', () => {
    const shapes: AnimatedDiagramBlock['shapes'] = [
      { id: 'box-a', kind: 'box', x: 5, y: 20, w: 20, h: 12, text: 'value' },
      // label without text — satisfies zod schema (optional) but validator rejects it
      { id: 'lbl', kind: 'label', x: 30, y: 10 },
      { id: 'box-b', kind: 'box', x: 47, y: 20, w: 22, h: 12, text: 'count' },
    ];
    const content = makeContentWithDiagram({
      shapes,
      steps: [
        { highlightIds: ['box-a'], caption: 'Start with the value on the right.' },
        { highlightIds: ['lbl', 'box-b'], caption: 'Label highlights reference known shapes.' },
      ],
    });
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('label') && e.includes('missing text'))).toBe(true);
  });

  it('passes when a box shape has no text (text is optional for box)', () => {
    const shapes: AnimatedDiagramBlock['shapes'] = [
      // box without text — should be fine
      { id: 'box-a', kind: 'box', x: 5, y: 20, w: 20, h: 12 },
      { id: 'arr', kind: 'arrow', x: 26, y: 26, toX: 46, toY: 26 },
      { id: 'box-b', kind: 'box', x: 47, y: 20, w: 22, h: 12 },
    ];
    const content = makeContentWithDiagram({ shapes });
    const result = validateLessonContent({ content, dossierSourceUrls: DOSSIER_SOURCE_URLS });
    // No diagram-related errors
    expect(result.errors.some((e) => e.includes('animated_diagram'))).toBe(false);
  });
});

// ── cross-fixture coherence: generate-lesson fixture vs synthesize-dossier sources ───────────────

describe('cross-fixture coherence', () => {
  it('generate-lesson fixture parses against lessonContentSchema', async () => {
    const { fakeOutputs } = await import('@/lib/ai-fixtures');
    const { lessonContentSchema } = await import('./blocks');
    const parsed = lessonContentSchema.safeParse(fakeOutputs['generate-lesson']);
    expect(parsed.success).toBe(true);
  });

  it('generate-lesson fixture passes validateLessonContent against synthesize-dossier source urls', async () => {
    const { fakeOutputs } = await import('@/lib/ai-fixtures');
    const { lessonContentSchema } = await import('./blocks');

    // Parse the generate-lesson fixture
    const parsed = lessonContentSchema.safeParse(fakeOutputs['generate-lesson']);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Source URLs from the synthesize-dossier fixture (as the plan specifies)
    const synthDossier = fakeOutputs['synthesize-dossier'] as {
      claims: Array<{ claim: string; sourceUrls: string[] }>;
    };
    const sourceUrls = [
      ...new Set(synthDossier.claims.flatMap((c) => c.sourceUrls)),
    ];

    const result = validateLessonContent({
      content: parsed.data,
      dossierSourceUrls: sourceUrls,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── readability validation ────────────────────────────────────────────────────

describe('validateLessonContent — readability gate', () => {
  it('passes when article is within 18_plus FK band (grade ≤14)', () => {
    const content = makeValidContent();
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      ageBand: '18_plus',
    });
    // The default fixture articles are grade ~7-10, well within limit 14
    expect(result.errors.filter((e) => e.includes('FK grade'))).toHaveLength(0);
  });

  it('fails when article FK grade exceeds 13_15 band limit (grade ≤9) — uses synthetic grade-16 text', () => {
    const content = makeValidContent();
    // Construct a complex, long-sentence text that produces a high FK grade
    const hardText =
      'The comprehensive multifaceted ramifications of contemporary technological infrastructure advancements necessitate sophisticated interdisciplinary methodological frameworks for systematic evaluation. ' +
      'Consequently, practitioners confronting multitudinous organizational stakeholder requirements must demonstrate extraordinary proficiency in coordinating simultaneous computational architectures. ' +
      'Furthermore, the philosophical underpinnings undergirding epistemological frameworks necessitate continuous reexamination considering multidimensional transformational paradigmatic shifts. ' +
      'Notwithstanding aforementioned complexities, organizational representatives must comprehensively accommodate multidimensional institutional ramifications arising from aforementioned considerations.';
    const article = content.blocks.find((b) => b.type === 'article')!;
    if (article.type === 'article') {
      article.markdown = hardText;
    }
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      ageBand: '13_15',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('FK grade') && e.includes('worst sentences'))).toBe(true);
  });

  it('skips readability check when ageBand is undefined', () => {
    const content = makeValidContent();
    // Even if the article is complex, no ageBand = no readability check
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
    });
    expect(result.errors.filter((e) => e.includes('FK grade'))).toHaveLength(0);
  });
});

// ── alias scan ───────────────────────────────────────────────────────────────

describe('validateLessonContent — glossary alias scan', () => {
  it('fails when a forbidden alias of a promoted term appears in article text', () => {
    const content = makeValidContent();
    // "variable" is promoted; "var" is an alias that appears in article markdown
    const article = content.blocks.find((b) => b.type === 'article')!;
    if (article.type === 'article') {
      article.markdown =
        'A var stores a value under a name. The var can hold any value. ' +
        'Variables let you track data. This is a named container.';
    }
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      glossaryAvoidAliases: [{ term: 'variable', aliases: ['var'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('var') && e.includes('variable'))).toBe(true);
  });

  it('is case-insensitive in alias matching', () => {
    const content = makeValidContent();
    const article = content.blocks.find((b) => b.type === 'article')!;
    if (article.type === 'article') {
      article.markdown = 'A Var is used to store values in many programs. Named containers are better.';
    }
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      glossaryAvoidAliases: [{ term: 'variable', aliases: ['var'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('var'))).toBe(true);
  });

  it('uses whole-word matching (does not flag "variable" when alias is "var")', () => {
    const content = makeValidContent();
    // "variable" contains "var" but only as a substring, not a whole word
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      glossaryAvoidAliases: [{ term: 'variable', aliases: ['var'] }],
    });
    // "variable" should NOT be flagged for alias "var" (whole-word match)
    expect(result.errors.filter((e) => e.includes('"var"'))).toHaveLength(0);
  });

  it('passes when no aliases appear in content', () => {
    const content = makeValidContent();
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      glossaryAvoidAliases: [{ term: 'variable', aliases: ['identifier', 'binding'] }],
    });
    // The fixture content does not contain "identifier" or "binding"
    expect(result.errors.filter((e) => e.includes('identifier') || e.includes('binding'))).toHaveLength(0);
  });

  it('also scans quiz item text for aliases', () => {
    const content = makeValidContent();
    const quiz = content.blocks.find((b) => b.type === 'quiz')!;
    if (quiz.type === 'quiz') {
      quiz.items[0].question = 'What does a var do in programming?';
    }
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      glossaryAvoidAliases: [{ term: 'variable', aliases: ['var'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('var'))).toBe(true);
  });

  it('skips alias scan when glossaryAvoidAliases is empty', () => {
    const content = makeValidContent();
    const result = validateLessonContent({
      content,
      dossierSourceUrls: DOSSIER_SOURCE_URLS,
      glossaryAvoidAliases: [],
    });
    expect(result.errors.filter((e) => e.includes('alias'))).toHaveLength(0);
  });
});
