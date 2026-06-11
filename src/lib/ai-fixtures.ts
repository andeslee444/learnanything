import type { LlmPurpose } from './ai';

/** Canned outputs for AI_FAKE_LLM=1. Each must parse against its call site's zod schema. */
export const fakeOutputs: Record<LlmPurpose, unknown> = {
  concreteness: {
    concrete: true,
    followUp: null,
  },
  'skill-graph': {
    nodes: [
      { name: 'Variables and types', summary: 'Declaring and using basic values', missionRelevance: 0.9 },
      { name: 'Control flow', summary: 'if/else and loops', missionRelevance: 0.85 },
      { name: 'Functions', summary: 'Defining and calling functions', missionRelevance: 0.9 },
      { name: 'Data structures', summary: 'Lists and maps', missionRelevance: 0.8 },
      { name: 'Error handling', summary: 'Failing gracefully', missionRelevance: 0.6 },
      { name: 'File I/O', summary: 'Reading and writing files', missionRelevance: 0.7 },
      { name: 'CLI arguments', summary: 'Parsing command-line input', missionRelevance: 0.95 },
      { name: 'Testing basics', summary: 'Writing first unit tests', missionRelevance: 0.65 },
      { name: 'Packaging', summary: 'Sharing a runnable tool', missionRelevance: 0.75 },
      { name: 'Project: ship the CLI', summary: 'Capstone tying it together', missionRelevance: 1 },
    ],
    edges: [
      { node: 'Control flow', prereq: 'Variables and types' },
      { node: 'Functions', prereq: 'Control flow' },
      { node: 'Data structures', prereq: 'Variables and types' },
      { node: 'Error handling', prereq: 'Functions' },
      { node: 'File I/O', prereq: 'Functions' },
      { node: 'CLI arguments', prereq: 'Functions' },
      { node: 'Testing basics', prereq: 'Functions' },
      { node: 'Packaging', prereq: 'Functions' },
      { node: 'Project: ship the CLI', prereq: 'Packaging' },
      { node: 'Project: ship the CLI', prereq: 'Error handling' },
    ],
  },
  'calibration-quiz': {
    items: [
      {
        id: 'cal-1',
        question: 'What does a variable do in a program?',
        options: ['Stores a value under a name', 'Draws on the screen', 'Connects to the internet', 'Compiles the code'],
        correctIndex: 0,
        conceptName: 'Variables and types',
      },
      {
        id: 'cal-2',
        question: 'What is the purpose of a loop?',
        options: ['Repeat work without copy-pasting code', 'Store a password', 'Style a web page', 'Send an email'],
        correctIndex: 0,
        conceptName: 'Control flow',
      },
    ],
  },
  'vet-sources': {
    verdicts: [
      { url: 'https://docs.python.org/3/tutorial/index.html', trusted: true, reason: 'official documentation' },
      { url: 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps', trusted: true, reason: 'recognized reference' },
      { url: 'https://realpython.com/command-line-interfaces-python-argparse/', trusted: true, reason: 'reputable editorial site' },
      { url: 'https://content-farm.example/listicle', trusted: false, reason: 'content farm' },
    ],
  },
  'extract-source': {
    claims: [
      { claim: 'Variables store values under a name.', quote: 'Variables store values under a name.' },
      { claim: 'Functions let you reuse logic.', quote: 'Functions are defined with def and let you reuse logic.' },
    ],
    glossarySeeds: [{ term: 'variable', definition: 'A named container for a value.' }],
    misconceptions: ['Variables contain values rather than referencing them.'],
  },
  'synthesize-dossier': {
    claims: [
      { claim: 'Variables store values under a name.', sourceUrls: ['https://docs.python.org/3/tutorial/index.html'] },
      { claim: 'Functions bundle reusable behavior.', sourceUrls: ['https://docs.python.org/3/tutorial/index.html', 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps'] },
      { claim: 'Command-line tools parse arguments and exit nonzero on errors.', sourceUrls: ['https://realpython.com/command-line-interfaces-python-argparse/'] },
      { claim: 'Loops repeat work without copy-pasting code.', sourceUrls: ['https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps'] },
    ],
    glossarySeeds: [{ term: 'variable', definition: 'A named container for a value.' }],
    misconceptions: ['Variables contain values rather than referencing them.'],
  },
  moderation: { allowed: true, reason: 'educational topic' },
  'distill-records': {
    records: [
      {
        recordType: 'demonstrated_understanding',
        title: 'Can use variables to store and update values',
        body: 'The learner correctly identified what a variable does and predicted the result of reassignment on the first attempt. This demonstrates an ability to reason about state changes in a program.',
        implications: 'Ready to apply variables inside control flow and functions.',
      },
    ],
    glossaryPromotions: [
      { term: 'variable', definition: 'A named container for a value.' },
    ],
  },
  // Phase 6 — extract-claims: two factual claims from the fixture article block
  // ("Variables: names for values" block in generate-lesson fixture).
  'extract-claims': {
    claims: [
      { claim: 'A variable stores a value under a name.' },
      { claim: 'Variables let the same code work with different values.' },
    ],
  },

  // Phase 6 — entail-claim: supported with the python docs url (from dossier fixture)
  'entail-claim': {
    verdict: 'supported',
    sourceUrl: 'https://docs.python.org/3/tutorial/index.html',
    note: 'The dossier explicitly states variables store values under a name.',
  },

  // Phase 6 — regenerate-block: one article block schema output
  // (single block, not the full lesson — matches regenerateBlockSchema in verify.ts)
  'regenerate-block': {
    type: 'article',
    heading: 'Variables: names for values',
    markdown:
      'A **variable** stores a value under a name so your program can refer to it later. Think of it as a labeled box: `count = 3` puts the number 3 in a box called count. Variables let the same code work with different values — update the box contents and every part of the code that reads the label sees the new value.',
    citationUrls: ['https://docs.python.org/3/tutorial/index.html'],
  },

  'create-reference-doc': {
    title: 'Variables and types',
    docType: 'cheat_sheet',
    sections: [
      {
        heading: 'What is a variable?',
        markdown: 'A **variable** is a named container for a value. Use it to store data your program needs to remember.\n\n```\ncount = 5   # stores 5 in count\nname = "Alice"  # stores "Alice" in name\n```',
      },
      {
        heading: 'Assignment',
        markdown: 'The `=` operator puts a value into a variable. Reassignment replaces the old value:\n\n```\nx = 3\nx = 7  # x is now 7\n```',
      },
      {
        heading: 'Naming rules',
        markdown: '- Use lowercase with underscores: `user_count`\n- Be descriptive: `total_price` beats `t`\n- Avoid reserved words: `for`, `while`, `if`',
      },
      {
        heading: 'Basic types',
        markdown: '| Type | Example | Notes |\n|------|---------|-------|\n| int | `42` | Whole numbers |\n| float | `3.14` | Decimal numbers |\n| str | `"hello"` | Text in quotes |\n| bool | `True` | True or False |',
      },
    ],
  },
  'plan-lesson': {
    objective: 'Declare and use variables to store values',
    format: 'article',
    estimatedMinutes: 8,
    blockOutline: [
      { type: 'article', focus: 'What a variable is and why programs need them' },
      { type: 'glossary_callout', focus: 'variable' },
      { type: 'quiz', focus: 'Predict the value stored after an assignment' },
      { type: 'article', focus: 'Naming variables well' },
    ],
  },
  'generate-lesson': {
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
      {
        type: 'flashcard_deck',
        cards: [
          { front: 'What is a variable?', back: 'A named container that stores a value — like a labeled box.' },
          { front: 'What does assignment do?', back: 'It puts a value into a variable: `count = 3` stores 3 in count.' },
          { front: 'Why do good names matter?', back: 'Clear names act as cheap documentation — `user_count` beats `x`.' },
        ],
      },
      {
        type: 'worked_example',
        problem: 'Store then update a count: start at 5, then change it to 7.',
        steps: [
          { text: 'Write `count = 5` — this creates a variable named count holding 5.' },
          { text: 'Write `count = 7` — assignment replaces the stored value; count now holds 7.' },
          { text: 'Read `count` — it returns 7, the most recently assigned value.' },
        ],
        completionItem: {
          id: 'we1',
          question: 'After `count = 5` then `count = 7`, what does `count` hold?',
          options: ['count holds 7', 'count holds 5', 'count holds 12', 'count is undefined'],
          correctIndex: 0,
          explanation: 'Assignment overwrites the previous value — count now holds 7.',
        },
      },
      {
        type: 'animated_diagram',
        title: 'Assignment flow: how a value moves into a variable',
        shapes: [
          { id: 'value-box', kind: 'box', x: 5, y: 20, w: 22, h: 14, text: 'value: 5' },
          { id: 'assign-arrow', kind: 'arrow', x: 28, y: 27, toX: 48, toY: 27 },
          { id: 'var-box', kind: 'box', x: 49, y: 20, w: 28, h: 14, text: 'count = ?' },
        ],
        steps: [
          {
            highlightIds: ['value-box'],
            caption: 'Start with the value 5 on the right-hand side of the assignment.',
          },
          {
            highlightIds: ['assign-arrow', 'var-box'],
            caption: 'The assignment operator copies 5 into the variable count — count now holds 5.',
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
  },
};
