import { describe, it, expect } from 'vitest';
import { validateLessonContent } from './validate';
import type { LessonValidationInput } from './validate';

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
