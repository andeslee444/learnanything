import { describe, it, expect, vi } from 'vitest';
import { badgeFor, faithfulnessScore, ALERT_THRESHOLD, pickArticleIndexes, computeFinalize, maybeAlertFaithfulness } from './verdicts';

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

// ── pickArticleIndexes ────────────────────────────────────────────────────────

describe('pickArticleIndexes', () => {
  it('returns 0-based indexes of article blocks only', () => {
    const blocks = [
      { type: 'article' },
      { type: 'glossary_callout' },
      { type: 'article' },
      { type: 'quiz' },
    ];
    expect(pickArticleIndexes(blocks)).toEqual([0, 2]);
  });

  it('returns empty array when no article blocks', () => {
    expect(pickArticleIndexes([{ type: 'glossary_callout' }])).toEqual([]);
    expect(pickArticleIndexes([])).toEqual([]);
  });
});

// ── computeFinalize ───────────────────────────────────────────────────────────

describe('computeFinalize', () => {
  it('returns verified status and score=1 when all rows verified', () => {
    const rows = [
      { claimsVerified: 2, claimsTotal: 2, status: 'verified' },
      { claimsVerified: 1, claimsTotal: 1, status: 'regenerated' },
    ];
    const result = computeFinalize(rows);
    expect(result.score).toBe(1.0);
    expect(result.verificationStatus).toBe('verified');
    expect(result.shouldAlert).toBe(false);
  });

  it('returns issues status when some rows unverified', () => {
    const rows = [
      { claimsVerified: 1, claimsTotal: 3, status: 'unverified' },
    ];
    const result = computeFinalize(rows);
    expect(result.verificationStatus).toBe('issues');
    // score = 1/3 ≈ 0.333 < 0.8 → shouldAlert = true
    expect(result.shouldAlert).toBe(true);
  });

  it('sets shouldAlert=true when score < ALERT_THRESHOLD', () => {
    const rows = [
      { claimsVerified: 2, claimsTotal: 3, status: 'unverified' },
    ];
    const result = computeFinalize(rows);
    // score = 2/3 ≈ 0.667 < 0.8
    expect(result.shouldAlert).toBe(true);
  });

  it('sets shouldAlert=false when score >= ALERT_THRESHOLD', () => {
    const rows = [
      { claimsVerified: 4, claimsTotal: 4, status: 'verified' },
    ];
    const result = computeFinalize(rows);
    expect(result.shouldAlert).toBe(false);
  });
});

// ── maybeAlertFaithfulness ────────────────────────────────────────────────────

describe('maybeAlertFaithfulness', () => {
  it('fires console.warn under ALERT_THRESHOLD', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      maybeAlertFaithfulness('lesson-abc', 0.6);
      expect(warnSpy).toHaveBeenCalledWith(
        '[founder-alert] faithfulness',
        expect.objectContaining({ lessonId: 'lesson-abc', score: 0.6 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT fire console.warn at or above ALERT_THRESHOLD', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      maybeAlertFaithfulness('lesson-xyz', 0.8);
      maybeAlertFaithfulness('lesson-xyz', 0.9);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
