import { z } from 'zod';

/**
 * LLM-output free text: live models exceed hard caps; truncate instead of failing the call.
 * Structural constraints stay strict (enums, booleans, numbers, ids, min-length floors).
 *
 * Use in place of `z.string().max(N)` on ANY free-text field that is an LLM output.
 * The transform is idempotent — text already ≤ max passes through unchanged, so this is
 * safe to use in schemas that are also used as storage/content contracts (validate paths).
 */
export function llmText(max: number) {
  return z.string().transform((s) => (s.length > max ? s.slice(0, max) : s));
}

/**
 * Like llmText but also enforces a minimum length floor (structural — an empty required
 * field IS malformed). Use when an empty string would break downstream rendering or logic.
 */
export function llmTextRequired(min: number, max: number) {
  return z
    .string()
    .min(min)
    .transform((s) => (s.length > max ? s.slice(0, max) : s));
}

/**
 * LLM list output: live models may return more items than the cap allows. Slice to `max`
 * instead of rejecting the entire response. Use where dropping extra items is safe
 * (claims lists, distractor pools, glossary candidate lists, etc.).
 */
export function llmArrayMax<T>(schema: z.ZodType<T>, max: number) {
  return z.array(schema).transform((a) => (a.length > max ? a.slice(0, max) : a));
}
