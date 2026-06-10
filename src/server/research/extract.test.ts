import { describe, it, expect, beforeEach } from 'vitest';
import { extractSource } from './extract';
import { synthesizeDossier } from './synthesize';
import type { SearchSource } from './provider';
import type { Extraction } from './extract';

beforeEach(() => {
  process.env.AI_FAKE_LLM = '1';
});

// ── extractSource ─────────────────────────────────────────────────────────────

describe('extractSource', () => {
  const source: SearchSource = {
    title: 'Python Tutorial — Official Documentation',
    url: 'https://docs.python.org/3/tutorial/index.html',
    text: 'Python is an easy to learn, powerful programming language. Variables store values under a name. Functions are defined with def and let you reuse logic.',
    publishedDate: '2026-01-15',
  };

  it('returns fixture claims tagged with the sourceUrl', async () => {
    const result = await extractSource(source, 'python variables');
    // Fixture from ai-fixtures.ts 'extract-source'
    expect(result.sourceUrl).toBe('https://docs.python.org/3/tutorial/index.html');
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0]).toMatchObject({
      claim: 'Variables store values under a name.',
      quote: 'Variables store values under a name.',
    });
    expect(result.claims[1]).toMatchObject({
      claim: 'Functions let you reuse logic.',
      quote: 'Functions are defined with def and let you reuse logic.',
    });
  });

  it('passes through glossarySeeds and misconceptions from the fixture', async () => {
    const result = await extractSource(source, 'python variables');
    expect(result.glossarySeeds).toHaveLength(1);
    expect(result.glossarySeeds[0]).toMatchObject({ term: 'variable', definition: 'A named container for a value.' });
    expect(result.misconceptions).toContain('Variables contain values rather than referencing them.');
  });
});

// ── synthesizeDossier citation guard ─────────────────────────────────────────

describe('synthesizeDossier citation guard', () => {
  // The 'synthesize-dossier' fixture returns four claims:
  //   Claim A: sourceUrls: ['https://docs.python.org/3/tutorial/index.html']
  //   Claim B: sourceUrls: ['https://docs.python.org/3/tutorial/index.html', 'https://developer.mozilla.org/...']
  //   Claim C: sourceUrls: ['https://realpython.com/command-line-interfaces-python-argparse/']
  //   Claim D: sourceUrls: ['https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps']
  //
  // By passing sources containing ONLY the MDN url, we exercise both behaviors:
  //   - Claims A and C are dropped entirely (their urls are not in sources)
  //   - Claim B keeps a subset of its sourceUrls (MDN survives; python.org is filtered out)
  //   - Claim D survives as-is (MDN is the only source and it is known)

  const MDN_URL = 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps';
  const PYTHON_URL = 'https://docs.python.org/3/tutorial/index.html';

  const dummyExtraction: Extraction = {
    sourceUrl: MDN_URL,
    claims: [{ claim: 'A variable is a container for a value.', quote: 'A variable is a container for a value.' }],
    glossarySeeds: [],
    misconceptions: [],
  };

  it('drops claims with no known sourceUrls and filters unknown urls from multi-source claims', async () => {
    // sources contains only MDN — python.org and realpython.com are not known
    const sources = [{ url: MDN_URL, title: 'MDN: JavaScript first steps' }];
    const result = await synthesizeDossier('variables', 'novice', [dummyExtraction], sources);

    // Claim A ('Variables store values under a name.') → only python.org → DROPPED
    const claimA = result.claims.find((c) => c.claim === 'Variables store values under a name.');
    expect(claimA).toBeUndefined();

    // Claim B ('Functions bundle reusable behavior.') → python.org filtered, MDN kept → SURVIVES with subset
    const claimB = result.claims.find((c) => c.claim === 'Functions bundle reusable behavior.');
    expect(claimB).toBeDefined();
    expect(claimB!.sourceUrls).toEqual([MDN_URL]);
    expect(claimB!.sourceUrls).not.toContain(PYTHON_URL);

    // Claim C ('Command-line tools parse arguments...') → only realpython.com → DROPPED
    const claimC = result.claims.find((c) => c.claim === 'Command-line tools parse arguments and exit nonzero on errors.');
    expect(claimC).toBeUndefined();

    // Claim D ('Loops repeat work...') → only MDN → SURVIVES
    const claimD = result.claims.find((c) => c.claim === 'Loops repeat work without copy-pasting code.');
    expect(claimD).toBeDefined();
    expect(claimD!.sourceUrls).toEqual([MDN_URL]);
  });

  it('keeps claims whose sourceUrls are all known', async () => {
    // sources contains all three urls — all claims should survive with all their urls
    const REALPYTHON_URL = 'https://realpython.com/command-line-interfaces-python-argparse/';
    const sources = [
      { url: PYTHON_URL, title: 'Python docs' },
      { url: MDN_URL, title: 'MDN' },
      { url: REALPYTHON_URL, title: 'Real Python' },
    ];
    const result = await synthesizeDossier('variables', 'novice', [dummyExtraction], sources);

    const claimA = result.claims.find((c) => c.claim === 'Variables store values under a name.');
    expect(claimA).toBeDefined();
    expect(claimA!.sourceUrls).toEqual([PYTHON_URL]);

    const claimB = result.claims.find((c) => c.claim === 'Functions bundle reusable behavior.');
    expect(claimB).toBeDefined();
    expect(claimB!.sourceUrls).toContain(PYTHON_URL);
    expect(claimB!.sourceUrls).toContain(MDN_URL);

    const claimC = result.claims.find((c) => c.claim === 'Command-line tools parse arguments and exit nonzero on errors.');
    expect(claimC).toBeDefined();
    expect(claimC!.sourceUrls).toEqual([REALPYTHON_URL]);

    // Claim D survives with its MDN url intact.
    const claimD = result.claims.find((c) => c.claim === 'Loops repeat work without copy-pasting code.');
    expect(claimD).toBeDefined();
    expect(claimD!.sourceUrls).toEqual([MDN_URL]);
  });

  it('passes sources through to the result', async () => {
    const sources = [{ url: MDN_URL, title: 'MDN', publishedDate: '2025-11-02' }];
    const result = await synthesizeDossier('variables', 'novice', [dummyExtraction], sources);
    expect(result.sources).toEqual(sources);
  });
});
