/**
 * Lightweight mock language model helper for unit tests.
 * Returns a fixed JSON string as the model output.
 *
 * Usage: createMockLanguageModel(jsonString) → LanguageModel
 * The returned model responds to any prompt with the provided JSON.
 */
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';

/**
 * Creates a MockLanguageModelV3 that always returns the given JSON text.
 * Compatible with llmObject's `modelOverride` parameter.
 */
export function createMockLanguageModel(jsonText: string): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: jsonText }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  }) as unknown as LanguageModel;
}

/**
 * Creates a MockLanguageModelV3 that returns successive responses from the provided array.
 * Call i returns responses[i]; if i >= responses.length, cycles back to the last response.
 * Useful when a function makes multiple llmObject calls (e.g. distill-records then create-reference-doc).
 */
export function createSequentialMockLanguageModel(responses: string[]): LanguageModel {
  let callIndex = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const text = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
}
