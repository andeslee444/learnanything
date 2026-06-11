/**
 * Pure verdict model for per-block verification results.
 * No DB access, no LLM calls — these are deterministic classifiers used
 * both inline and in tests.
 */

import { alertFounder } from '@/lib/alerts';

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

// ── shared pure helpers (consumed by workflow steps, tests, and evals) ─────────

/**
 * Return the 0-based indexes of article blocks in a content block array.
 * Pure — no DB or LLM calls.
 */
export function pickArticleIndexes(blocks: ReadonlyArray<{ type: string }>): number[] {
  return blocks.map((b, i) => (b.type === 'article' ? i : -1)).filter((i) => i !== -1);
}

/**
 * Compute the finalize result (faithfulness score, verificationStatus, shouldAlert)
 * from a set of verification_results rows.
 * Pure — no DB or LLM calls.
 */
export function computeFinalize(
  rows: ReadonlyArray<{ claimsVerified: number; claimsTotal: number; status: string }>,
): { score: number; verificationStatus: 'verified' | 'issues'; shouldAlert: boolean } {
  const score = faithfulnessScore(rows);
  const allVerified = rows.every((r) => r.status === 'verified' || r.status === 'regenerated');
  const verificationStatus: 'verified' | 'issues' = allVerified ? 'verified' : 'issues';
  return { score, verificationStatus, shouldAlert: score < ALERT_THRESHOLD };
}

/**
 * Fire the founder-alert if score < ALERT_THRESHOLD.
 * Delegates to alertFounder (the single seam) so tests can spy alertFounder.
 * Pure logic (threshold check) kept here — call sites and existing tests unchanged.
 */
export function maybeAlertFaithfulness(lessonId: string, score: number): void {
  if (score < ALERT_THRESHOLD) {
    alertFounder('faithfulness', { lessonId, score });
  }
}
