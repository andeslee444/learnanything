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
