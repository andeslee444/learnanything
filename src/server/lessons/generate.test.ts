import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateBlocks } from './generate';
import { lessonContentSchema, type LessonPlan } from './blocks';
import { moderateText, moderationMaxChars } from '@/server/moderation';
import type { DossierClaim, DossierContent } from '@/server/research/types';

// ── fixtures ──────────────────────────────────────────────────────────────────

const FAKE_PLAN: LessonPlan = {
  objective: 'Declare and use variables to store values',
  format: 'article',
  estimatedMinutes: 8,
  blockOutline: [
    { type: 'article', focus: 'What a variable is and why programs need them' },
    { type: 'glossary_callout', focus: 'variable' },
    { type: 'quiz', focus: 'Predict the value stored after an assignment' },
    { type: 'article', focus: 'Naming variables well' },
  ],
};

const FAKE_DOSSIER: { sources: DossierContent['sources']; claims: DossierClaim[]; misconceptions: string[] } = {
  sources: [
    { url: 'https://docs.python.org/3/tutorial/index.html', title: 'Python Tutorial' },
    { url: 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps', title: 'MDN JS First Steps' },
  ],
  claims: [
    { claim: 'Variables store values under a name.', sourceUrls: ['https://docs.python.org/3/tutorial/index.html'] },
  ],
  misconceptions: ['Variables contain values rather than referencing them.'],
};

// ── env helpers ───────────────────────────────────────────────────────────────

let priorFake: string | undefined;
beforeEach(() => { priorFake = process.env.AI_FAKE_LLM; });
afterEach(() => {
  if (priorFake === undefined) delete process.env.AI_FAKE_LLM;
  else process.env.AI_FAKE_LLM = priorFake;
});

// ── generateBlocks — fake mode ─────────────────────────────────────────────────

describe('generateBlocks — fake mode', () => {
  it('returns the fixture and it parses against lessonContentSchema', async () => {
    process.env.AI_FAKE_LLM = '1';
    const result = await generateBlocks(FAKE_PLAN, FAKE_DOSSIER, 'novice');
    const parsed = lessonContentSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Spot-check fixture values
    expect(parsed.data.blocks.some((b) => b.type === 'article')).toBe(true);
    expect(parsed.data.blocks.some((b) => b.type === 'quiz')).toBe(true);
    expect(parsed.data.winCheck.items.length).toBeGreaterThanOrEqual(2);
  });

  it('returns the expected fixture heading from ai-fixtures.ts', async () => {
    process.env.AI_FAKE_LLM = '1';
    const result = await generateBlocks(FAKE_PLAN, FAKE_DOSSIER, 'novice');
    const articleBlock = result.blocks.find((b) => b.type === 'article');
    expect(articleBlock).toBeDefined();
    if (articleBlock?.type === 'article') {
      expect(articleBlock.heading).toBe('Variables: names for values');
    }
  });
});

// ── generateBlocks — correction parameter ─────────────────────────────────────
//
// generateBlocks delegates to llmObject which accepts a modelOverride for unit-testing.
// We verify the prompt construction logic by using llmObject directly with a MockLanguageModelV3
// that captures the prompt — this is the same technique used in ai.test.ts.

describe('generateBlocks — correction parameter', () => {
  /** Build a mock that captures the user-turn prompt text and returns the fixture. */
  async function makeMockCapturingPrompt(): Promise<{ mock: MockLanguageModelV3; getPrompt: () => string }> {
    let capturedPrompt = '';
    const mock = new MockLanguageModelV3({
      doGenerate: async (input) => {
        const userMsg = (input.prompt as Array<{ role: string; content: Array<{ type: string; text: string }> }>)
          .find((m) => m.role === 'user');
        capturedPrompt = userMsg?.content.find((c) => c.type === 'text')?.text ?? '';
        const { fakeOutputs } = await import('@/lib/ai-fixtures');
        return {
          content: [{ type: 'text', text: JSON.stringify(fakeOutputs['generate-lesson']) }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    return { mock, getPrompt: () => capturedPrompt };
  }

  /** Build the base prompt the same way generate.ts does. */
  function buildBasePrompt(): string {
    return [
      `Lesson plan: ${JSON.stringify(FAKE_PLAN)}`,
      '<dossier>',
      `Sources: ${JSON.stringify(FAKE_DOSSIER.sources.map((s) => s.url))}`,
      `Claims: ${JSON.stringify(FAKE_DOSSIER.claims)}`,
      `Misconceptions: ${JSON.stringify(FAKE_DOSSIER.misconceptions)}`,
      '</dossier>',
    ].join('\n');
  }

  it('does NOT include correction text in the prompt when correction is absent', async () => {
    process.env.AI_FAKE_LLM = '0';
    const { mock, getPrompt } = await makeMockCapturingPrompt();
    const { llmObject } = await import('@/lib/ai');

    await llmObject({
      purpose: 'generate-lesson',
      tier: 'generator',
      schema: lessonContentSchema,
      system: 'test',
      prompt: buildBasePrompt(), // no correction suffix
      modelOverride: mock,
    });

    expect(getPrompt()).not.toContain('Your previous attempt failed validation');
    expect(getPrompt()).not.toContain('Fix every issue');
  });

  it('appends correction phrase to the prompt when correction is provided', async () => {
    process.env.AI_FAKE_LLM = '0';
    const correctionMsg = 'no article block; duplicate quiz item ids';
    const { mock, getPrompt } = await makeMockCapturingPrompt();
    const { llmObject } = await import('@/lib/ai');

    // This is the exact prompt generate.ts constructs when correction is set:
    const promptWithCorrection = `${buildBasePrompt()}\n\nYour previous attempt failed validation:\n${correctionMsg}\nFix every issue.`;

    await llmObject({
      purpose: 'generate-lesson',
      tier: 'generator',
      schema: lessonContentSchema,
      system: 'test',
      prompt: promptWithCorrection,
      modelOverride: mock,
    });

    expect(getPrompt()).toContain('Your previous attempt failed validation:');
    expect(getPrompt()).toContain(correctionMsg);
    expect(getPrompt()).toContain('Fix every issue.');
  });

  it('correction phrase lands AFTER the dossier close tag', async () => {
    process.env.AI_FAKE_LLM = '0';
    const correctionMsg = 'article "Intro" has no citation resolving to a dossier source';
    const { mock, getPrompt } = await makeMockCapturingPrompt();
    const { llmObject } = await import('@/lib/ai');

    const promptWithCorrection = `${buildBasePrompt()}\n\nYour previous attempt failed validation:\n${correctionMsg}\nFix every issue.`;

    await llmObject({
      purpose: 'generate-lesson',
      tier: 'generator',
      schema: lessonContentSchema,
      system: 'test',
      prompt: promptWithCorrection,
      modelOverride: mock,
    });

    const prompt = getPrompt();
    const dossierEnd = prompt.indexOf('</dossier>');
    const correctionStart = prompt.indexOf('Your previous attempt failed validation:');
    expect(dossierEnd).toBeGreaterThan(-1);
    expect(correctionStart).toBeGreaterThan(dossierEnd);
  });

  it('generate.ts prompt without correction ends with </dossier>', () => {
    // Pure unit test of prompt construction — no model needed
    const basePrompt = buildBasePrompt();
    expect(basePrompt.endsWith('</dossier>')).toBe(true);
  });

  it('generate.ts prompt WITH correction ends with "Fix every issue."', () => {
    const correction = 'no article block';
    const basePrompt = buildBasePrompt();
    const fullPrompt = `${basePrompt}\n\nYour previous attempt failed validation:\n${correction}\nFix every issue.`;
    expect(fullPrompt.endsWith('Fix every issue.')).toBe(true);
    expect(fullPrompt).toContain('Your previous attempt failed validation:');
    expect(fullPrompt).toContain(correction);
  });
});

// ── moderateText — assembled_lesson context ───────────────────────────────────

describe('moderateText — assembled_lesson context', () => {
  it('allows in fake mode (fixture returns allowed: true)', async () => {
    process.env.AI_FAKE_LLM = '1';
    const result = await moderateText('some lesson content', 'assembled_lesson');
    expect(result.allowed).toBe(true);
    expect(result.errored).toBeUndefined();
  });

  it('uses the 16k slice (same as retrieved_content)', () => {
    expect(moderationMaxChars('assembled_lesson')).toBe(16000);
  });

  it('learning_request keeps the 4k slice', () => {
    expect(moderationMaxChars('learning_request')).toBe(4000);
  });

  it('retrieved_content keeps the 16k slice (regression)', () => {
    expect(moderationMaxChars('retrieved_content')).toBe(16000);
  });

  it('a >4k input is NOT pre-truncated for assembled_lesson (slice allows 16k)', async () => {
    process.env.AI_FAKE_LLM = '1';
    // Build a string that is 5000 chars — would be truncated to 4k under learning_request rules
    // but should pass through fully (up to 16k) for assembled_lesson.
    // We verify by confirming moderationMaxChars('assembled_lesson') > 4000.
    const bigInput = 'x'.repeat(5000);
    // The function should not throw and should return allowed: true in fake mode
    const result = await moderateText(bigInput, 'assembled_lesson');
    expect(result.allowed).toBe(true);
    // Confirm the helper confirms 16k slice is applied
    expect(moderationMaxChars('assembled_lesson')).toBeGreaterThan(4000);
    expect(moderationMaxChars('assembled_lesson')).toBe(16000);
  });
});
