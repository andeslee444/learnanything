import { describe, it, expect, vi, afterEach } from 'vitest';
import { badgeFor, faithfulnessScore, ALERT_THRESHOLD } from './verdicts';

// ── badgeFor ──────────────────────────────────────────────────────────────────

describe('badgeFor', () => {
  it('returns "verified" when all claims are verified and total >= 1', () => {
    expect(badgeFor(3, 3)).toBe('verified');
    expect(badgeFor(1, 1)).toBe('verified');
  });

  it('returns "unverified" when some claims are not verified', () => {
    expect(badgeFor(2, 3)).toBe('unverified');
    expect(badgeFor(0, 1)).toBe('unverified');
    expect(badgeFor(0, 5)).toBe('unverified');
  });

  // Zero-claim article blocks: definitional prose with no factual assertions.
  // We classify these as "verified" (nothing to refute) — comment it here and in the source.
  it('returns "verified" for zero-claim blocks (definitional prose)', () => {
    expect(badgeFor(0, 0)).toBe('verified');
  });
});

// ── faithfulnessScore ─────────────────────────────────────────────────────────

describe('faithfulnessScore', () => {
  it('returns ratio of verified / total across all results', () => {
    const results = [
      { claimsVerified: 2, claimsTotal: 3 },
      { claimsVerified: 1, claimsTotal: 1 },
    ];
    // (2+1)/(3+1) = 3/4 = 0.75
    expect(faithfulnessScore(results)).toBeCloseTo(0.75);
  });

  it('returns 1.0 when all claims verified', () => {
    expect(faithfulnessScore([{ claimsVerified: 3, claimsTotal: 3 }])).toBe(1.0);
  });

  it('returns 0 when no claims verified', () => {
    expect(faithfulnessScore([{ claimsVerified: 0, claimsTotal: 3 }])).toBe(0);
  });

  // total = 0 across all rows → 1.0 (nothing to refute — matches badgeFor(0,0))
  it('returns 1.0 when total is 0 across all results', () => {
    expect(faithfulnessScore([])).toBe(1.0);
    expect(faithfulnessScore([{ claimsVerified: 0, claimsTotal: 0 }])).toBe(1.0);
  });
});

// ── ALERT_THRESHOLD ───────────────────────────────────────────────────────────

describe('ALERT_THRESHOLD', () => {
  it('is 0.8', () => {
    expect(ALERT_THRESHOLD).toBe(0.8);
  });
});
