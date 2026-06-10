/**
 * Unit tests for readability.ts — Flesch-Kincaid Grade Level formula + helpers.
 *
 * Tolerance ±1.5 FK grade against known-grade sample texts.
 */
import { describe, it, expect } from 'vitest';
import { fleschKincaidGrade, stripMarkdown, worstSentences, countSyllables, READABILITY_BAND_TARGETS } from './readability';

// ── Known-grade calibration samples ──────────────────────────────────────────
//
// The FK formula is:  grade = 0.39 * ASL + 11.8 * ASW - 15.59
// with a vowel-group syllable heuristic. We test three samples whose expected
// grade levels span the range used in our app, verified empirically.
// Tolerance ±1.5 around the measured values from this implementation.
//
// Sample A — moderate prose (our fixture article 1, grade ~7):
const SAMPLE_A =
  'A variable stores a value under a name so your program can use it later. Think of it as a labeled box: count equals 3 puts the value 3 in a box labeled count. When the program reads count, it finds 3. Variables let the same code work with different values — change what goes in the box, and everything that reads the label sees the new value. This is the first building block of every program you will write.';

// Sample B — clear explanatory prose (our fixture article 2, grade ~10):
const SAMPLE_B =
  'Names should say what the value means: user_count beats x. Future-you reads code far more often than writes it, and clear names are the cheapest documentation there is. Most languages have conventions — follow what the codebase around you does.';

// Sample C — higher-complexity prose using longer sentences and polysyllabic words (grade ~12):
const SAMPLE_C =
  'Learning to program involves developing a new way of thinking. You must instruct the computer in precise, unambiguous steps. Each instruction executes in sequence, and the computer has no ability to infer intent or correct mistakes. Practicing this discipline builds strong computational reasoning skills.';

describe('fleschKincaidGrade — known-grade samples (±1.5 tolerance)', () => {
  it('Sample A produces a grade in range 5.5 to 8.5 (measured ~7.1)', () => {
    const grade = fleschKincaidGrade(SAMPLE_A);
    expect(grade).toBeGreaterThan(5.5);
    expect(grade).toBeLessThan(8.5);
  });

  it('Sample B produces a grade in range 8.5 to 11.5 (measured ~10.1)', () => {
    const grade = fleschKincaidGrade(SAMPLE_B);
    expect(grade).toBeGreaterThan(8.5);
    expect(grade).toBeLessThan(11.5);
  });

  it('Sample C produces a grade in range 10.5 to 13.5 (measured ~12.0)', () => {
    const grade = fleschKincaidGrade(SAMPLE_C);
    expect(grade).toBeGreaterThan(10.5);
    expect(grade).toBeLessThan(13.5);
  });
});

describe('fleschKincaidGrade — edge cases', () => {
  it('returns 0 for empty text', () => {
    expect(fleschKincaidGrade('')).toBe(0);
  });

  it('returns a finite number for single sentence', () => {
    const grade = fleschKincaidGrade('Hello world.');
    expect(isFinite(grade)).toBe(true);
  });
});

// ── Age-band gate constants ────────────────────────────────────────────────────

describe('READABILITY_BAND_TARGETS', () => {
  it('13_15 → ≤9', () => {
    expect(READABILITY_BAND_TARGETS['13_15']).toBe(9);
  });

  it('16_17 → ≤11', () => {
    expect(READABILITY_BAND_TARGETS['16_17']).toBe(11);
  });

  it('18_plus → ≤14', () => {
    expect(READABILITY_BAND_TARGETS['18_plus']).toBe(14);
  });

  it('fixture article 1 passes 18_plus band (grade ~6.9)', () => {
    const markdown =
      'A **variable** stores a value under a name so your program can use it later. Think of it as a labeled box: `count = 3` puts the value 3 in a box labeled count. When the program reads `count`, it finds 3. Variables let the same code work with different values — change what goes in the box, and everything that reads the label sees the new value. This is the first building block of every program you will write.';
    const grade = fleschKincaidGrade(stripMarkdown(markdown));
    expect(grade).toBeLessThanOrEqual(READABILITY_BAND_TARGETS['18_plus']);
  });

  it('fixture article 2 passes 18_plus band (grade ~10.1)', () => {
    const markdown =
      'Names should say what the value MEANS: `user_count` beats `x`. Future-you reads code far more often than writes it, and clear names are the cheapest documentation there is. Most languages have conventions — follow what the codebase around you does.';
    const grade = fleschKincaidGrade(stripMarkdown(markdown));
    expect(grade).toBeLessThanOrEqual(READABILITY_BAND_TARGETS['18_plus']);
  });
});

// ── countSyllables ─────────────────────────────────────────────────────────────

describe('countSyllables', () => {
  it('counts single vowel group', () => {
    // "cat" → one vowel group "a" → 1 syllable
    expect(countSyllables('cat')).toBe(1);
  });

  it('counts two vowel groups', () => {
    // "table" → "a" + "e" → 2 syllables
    expect(countSyllables('table')).toBe(2);
  });

  it('returns at least 1 for non-empty word', () => {
    expect(countSyllables('xyz')).toBeGreaterThanOrEqual(1);
  });

  it('returns 0 for empty string', () => {
    expect(countSyllables('')).toBe(0);
  });

  it('handles multi-vowel groups correctly', () => {
    // "beautiful" → "eau" + "i" + "u" = 3 vowel groups → 3
    expect(countSyllables('beautiful')).toBe(3);
  });
});

// ── stripMarkdown ──────────────────────────────────────────────────────────────

describe('stripMarkdown', () => {
  it('removes inline code backticks but preserves word', () => {
    expect(stripMarkdown('Use `count` here.')).not.toContain('`');
    expect(stripMarkdown('Use `count` here.')).toContain('count');
  });

  it('removes bold markers', () => {
    expect(stripMarkdown('A **variable** stores.')).not.toContain('**');
    expect(stripMarkdown('A **variable** stores.')).toContain('variable');
  });

  it('removes inline links', () => {
    const result = stripMarkdown('See [docs](https://example.com).');
    expect(result).not.toContain('https://example.com');
    expect(result).toContain('docs');
  });

  it('collapses extra whitespace', () => {
    expect(stripMarkdown('  hello   world  ')).toBe('hello world');
  });
});

// ── worstSentences ────────────────────────────────────────────────────────────

describe('worstSentences', () => {
  it('returns up to 2 sentences sorted by grade descending', () => {
    const text =
      'The cat sat on the mat. The Flesch-Kincaid readability tests were originally developed for the United States Navy to assess the difficulty of technical manuals. Dogs run fast.';
    const worst = worstSentences(text, 2);
    expect(worst).toHaveLength(2);
    expect(worst[0].grade).toBeGreaterThanOrEqual(worst[1].grade);
  });

  it('returns fewer than topN when text has fewer sentences', () => {
    const worst = worstSentences('One sentence only.', 2);
    expect(worst.length).toBeLessThanOrEqual(1);
  });
});
