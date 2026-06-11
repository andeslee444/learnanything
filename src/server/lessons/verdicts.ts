/**
 * Pure verdict model for per-block verification results.
 * No DB access, no LLM calls — these are deterministic classifiers used
 * both inline and in tests.
 */

/** Score below this threshold triggers a founder-alert console.warn. */
export const ALERT_THRESHOLD = 0.8;

/**
 * Derive the badge for a single article block.
 *
 * Rules:
 * - "verified" if ALL claims are verified AND total >= 1.
 * - "unverified" if any claim is not verified.
 * - Zero-claim blocks (total === 0) → "verified".
 *   Rationale: zero-claim blocks are definitional prose that contains no
 *   independently checkable factual assertions; there is nothing to refute.
 */
export function badgeFor(claimsVerified: number, claimsTotal: number): 'verified' | 'unverified' {
  // Zero-claim blocks: definitional prose — verified by definition.
  if (claimsTotal === 0) return 'verified';
  return claimsVerified === claimsTotal ? 'verified' : 'unverified';
}

/**
 * Aggregate faithfulness score for a lesson: sum(verified) / sum(total).
 * Returns 1.0 when total across all rows is 0 (mirrors the zero-claim block rule).
 */
export function faithfulnessScore(
  results: ReadonlyArray<{ claimsVerified: number; claimsTotal: number }>,
): number {
  let totalVerified = 0;
  let totalClaims = 0;
  for (const r of results) {
    totalVerified += r.claimsVerified;
    totalClaims += r.claimsTotal;
  }
  // No claims across the entire lesson → nothing to refute → 1.0
  if (totalClaims === 0) return 1.0;
  return totalVerified / totalClaims;
}
