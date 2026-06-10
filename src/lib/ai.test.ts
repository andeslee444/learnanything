import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { llmObject } from './ai';

const schema = z.object({ answer: z.string() });

describe('llmObject', () => {
  let priorFake: string | undefined;
  beforeEach(() => { priorFake = process.env.AI_FAKE_LLM; });
  afterEach(() => { process.env.AI_FAKE_LLM = priorFake; });

  it('serves fixtures in fake mode', async () => {
    process.env.AI_FAKE_LLM = '1';
    const out = await llmObject({
      purpose: 'concreteness',
      tier: 'classifier',
      schema: z.object({ concrete: z.boolean(), followUp: z.string().nullable() }),
      system: 's',
      prompt: 'p',
    });
    expect(out.concrete).toBe(true);
  });

  it('parses structured output from the model (mock)', async () => {
    process.env.AI_FAKE_LLM = '0';
    const mock = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ answer: '42' }) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const out = await llmObject({
      purpose: 'concreteness', tier: 'classifier', schema, system: 's', prompt: 'p', modelOverride: mock,
    });
    expect(out.answer).toBe('42');
  });

  it('rejects fixture/schema drift', async () => {
    process.env.AI_FAKE_LLM = '1';
    await expect(
      llmObject({ purpose: 'concreteness', tier: 'classifier', schema: z.object({ nope: z.number() }), system: 's', prompt: 'p' })
    ).rejects.toThrow();
  });
});
