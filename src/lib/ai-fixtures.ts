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
};
