import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { extractClaims, entailClaim } from './verify';

// ── env helpers ───────────────────────────────────────────────────────────────

let priorFake: string | undefined;
beforeEach(() => { priorFake = process.env.AI_FAKE_LLM; });
afterEach(() => {
  if (priorFake === undefined) delete process.env.AI_FAKE_LLM;
  else process.env.AI_FAKE_LLM = priorFake;
});

// ── Fixture data ──────────────────────────────────────────────────────────────

// The first article block from the generate-lesson fixture.
const FIXTURE_ARTICLE_MARKDOWN =
  'A **variable** stores a value under a name so your program can use it later. Think of it as a labeled box: `count = 3` puts the value 3 in a box labeled count. When the program reads `count`, it finds 3. Variables let the same code work with different values — change what goes in the box, and everything that reads the label sees the new value. This is the first building block of every program you will write.';

const DOSSIER_CLAIMS = [
  { claim: 'Variables store values under a name.', sourceUrls: ['https://docs.python.org/3/tutorial/index.html'] },
];

const DOSSIER_SOURCE_URLS = ['https://docs.python.org/3/tutorial/index.html'];

// ── extractClaims — fake mode ─────────────────────────────────────────────────

describe('extractClaims — fake mode', () => {
  it('returns 2 claims matching the fixture article block', async () => {
    process.env.AI_FAKE_LLM = '1';
    const claims = await extractClaims(FIXTURE_ARTICLE_MARKDOWN);

    expect(claims).toHaveLength(2);
    expect(claims[0].claim).toBe('A variable stores a value under a name.');
    expect(claims[1].claim).toBe('Variables let the same code work with different values.');
  });

  it('fixture schema-valid: each claim is a string ≤300 chars', async () => {
    process.env.AI_FAKE_LLM = '1';
    const claims = await extractClaims(FIXTURE_ARTICLE_MARKDOWN);
    for (const { claim } of claims) {
      expect(typeof claim).toBe('string');
      expect(claim.length).toBeGreaterThan(0);
      expect(claim.length).toBeLessThanOrEqual(300);
    }
  });
});

// ── entailClaim — fake mode ───────────────────────────────────────────────────

describe('entailClaim — fake mode', () => {
  it('returns "supported" with the python doc url', async () => {
    process.env.AI_FAKE_LLM = '1';
    const result = await entailClaim(
      'A variable stores a value under a name.',
      DOSSIER_CLAIMS,
      DOSSIER_SOURCE_URLS,
    );
    expect(result.verdict).toBe('supported');
    expect(result.sourceUrl).toBe('https://docs.python.org/3/tutorial/index.html');
  });
});

// ── url-guard — deterministic code path ──────────────────────────────────────

describe('entailClaim — url-guard', () => {
  /**
   * Build a mock that returns a 'supported' verdict with a given sourceUrl.
   * Used to test the deterministic code guard (not the LLM).
   */
  function mockEntailWithUrl(sourceUrl: string | null) {
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ verdict: 'supported', sourceUrl, note: 'mock note' }),
          },
        ],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
  }

  it('url in dossier set → verdict stays "supported"', async () => {
    process.env.AI_FAKE_LLM = '0';
    const mock = mockEntailWithUrl('https://docs.python.org/3/tutorial/index.html');
    const result = await entailClaim(
      'Variables store values under a name.',
      DOSSIER_CLAIMS,
      DOSSIER_SOURCE_URLS,
      { modelOverride: mock },
    );
    expect(result.verdict).toBe('supported');
    expect(result.sourceUrl).toBe('https://docs.python.org/3/tutorial/index.html');
  });

  it('url NOT in dossier set → "supported" is demoted to "unsupported"', async () => {
    process.env.AI_FAKE_LLM = '0';
    const mock = mockEntailWithUrl('https://foreign-site.example/article');
    const result = await entailClaim(
      'Variables store values under a name.',
      DOSSIER_CLAIMS,
      DOSSIER_SOURCE_URLS, // only contains python.org
      { modelOverride: mock },
    );
    // Code guard: foreign url not in dossier set → unsupported
    expect(result.verdict).toBe('unsupported');
    expect(result.sourceUrl).toBeNull();
  });

  it('null sourceUrl with "supported" verdict → "unsupported"', async () => {
    process.env.AI_FAKE_LLM = '0';
    const mock = mockEntailWithUrl(null);
    const result = await entailClaim(
      'Variables store values under a name.',
      DOSSIER_CLAIMS,
      DOSSIER_SOURCE_URLS,
      { modelOverride: mock },
    );
    // Code guard: supported with null url → unsupported
    expect(result.verdict).toBe('unsupported');
    expect(result.sourceUrl).toBeNull();
  });
});

// ── zero-claims path ──────────────────────────────────────────────────────────

describe('extractClaims — zero-claims path', () => {
  it('returns empty array for definitional/zero-claim content', async () => {
    process.env.AI_FAKE_LLM = '0';
    const mock = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ claims: [] }) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const claims = await extractClaims('A variable is a named container.', { modelOverride: mock });
    expect(claims).toHaveLength(0);
  });
});
