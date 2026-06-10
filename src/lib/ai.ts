import { generateText, Output, gateway } from 'ai';
import type { LanguageModel } from 'ai';
import type { z } from 'zod'; // type-only import; `Output.object` handles schema validation

// Gateway model IDs verified 2026-06-10 via https://ai-gateway.vercel.sh/v1/models
export const MODEL_TIERS = {
  planner: 'anthropic/claude-opus-4.8', // skill-graph decomposition (spec §2 track init)
  generator: 'anthropic/claude-sonnet-4.6', // calibration quiz + future sub-tasks
  classifier: 'anthropic/claude-haiku-4.5', // concreteness check + future classification
} as const;
export type ModelTier = keyof typeof MODEL_TIERS;

export type LlmPurpose = 'concreteness' | 'skill-graph' | 'calibration-quiz';

/**
 * Single entry point for structured LLM calls.
 * AI_FAKE_LLM=1 serves schema-validated fixtures (tests/e2e/CI) — no key, no spend.
 * `modelOverride` exists for unit-testing this helper with MockLanguageModelV3.
 */
export async function llmObject<T>(opts: {
  purpose: LlmPurpose;
  tier: ModelTier;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  modelOverride?: LanguageModel;
}): Promise<T> {
  if (!opts.modelOverride && process.env.AI_FAKE_LLM === '1') {
    const { fakeOutputs } = await import('./ai-fixtures');
    return opts.schema.parse(fakeOutputs[opts.purpose]);
  }
  const model: LanguageModel = opts.modelOverride ?? gateway(MODEL_TIERS[opts.tier]);
  const { output } = await generateText({
    model,
    output: Output.object({ schema: opts.schema }),
    system: opts.system,
    prompt: opts.prompt,
  });
  return output as T;
}
