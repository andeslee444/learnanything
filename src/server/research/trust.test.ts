import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { normalizeDomain, getAllowlist, getBlocklist, vetSources } from './trust';
import type { SearchSource } from './provider';

// ── unit: normalizeDomain ─────────────────────────────────────────────────────

describe('normalizeDomain', () => {
  it('strips https:// and lowercases', () => {
    expect(normalizeDomain('https://docs.python.org/3/tutorial/')).toBe('docs.python.org');
  });

  it('strips leading www', () => {
    expect(normalizeDomain('https://WWW.Docs.Python.org/3/x')).toBe('docs.python.org');
  });

  it('handles bare hostname', () => {
    expect(normalizeDomain('Example.COM')).toBe('example.com');
  });

  it('handles bare www hostname', () => {
    expect(normalizeDomain('www.example.com')).toBe('example.com');
  });

  it('leaves subdomain other than www intact', () => {
    expect(normalizeDomain('blog.example.com')).toBe('blog.example.com');
  });
});

// ── integration: allowlist / blocklist queries ────────────────────────────────

describe('getAllowlist and getBlocklist', () => {
  beforeAll(resetDb);
  afterAll(() => testPool.end());

  beforeAll(async () => {
    await testDb.insert(s.trustDomains).values([
      // programming tier1 — should appear in allowlist
      { vertical: 'programming', domain: 'docs.python.org', tier: 'tier1', note: 'official' },
      // programming tier2 — should appear in allowlist
      { vertical: 'programming', domain: 'realpython.com', tier: 'tier2', note: 'editorial' },
      // programming tier3 — should NOT appear in allowlist
      { vertical: 'programming', domain: 'some-tier3.com', tier: 'tier3', note: 'tier3' },
      // global blocked (vertical = null) — should appear in blocklist
      { vertical: null, domain: 'quora.com', tier: 'blocked', note: 'answer mill' },
      // history tier1 — should NOT appear in programming allowlist
      { vertical: 'history', domain: 'britannica.com', tier: 'tier1', note: 'institutional' },
    ]);
  });

  it('allowlist returns tier1 and tier2 domains for the given vertical only', async () => {
    const list = await getAllowlist(testDb, 'programming');
    expect(list).toContain('docs.python.org');
    expect(list).toContain('realpython.com');
    expect(list).not.toContain('some-tier3.com');
    expect(list).not.toContain('britannica.com');
    expect(list).not.toContain('quora.com');
  });

  it('allowlist for a different vertical returns that vertical only', async () => {
    const list = await getAllowlist(testDb, 'history');
    expect(list).toContain('britannica.com');
    expect(list).not.toContain('docs.python.org');
  });

  it('blocklist returns only globally-blocked domains (vertical = null)', async () => {
    const list = await getBlocklist(testDb);
    expect(list).toContain('quora.com');
    expect(list).not.toContain('docs.python.org');
    expect(list).not.toContain('britannica.com');
  });

  it('empty allowlist for unknown vertical', async () => {
    const list = await getAllowlist(testDb, 'unknown-vertical');
    expect(list).toHaveLength(0);
  });
});

// ── integration: vetSources with AI_FAKE_LLM=1 ───────────────────────────────

describe('vetSources', () => {
  beforeEach(() => {
    process.env.AI_FAKE_LLM = '1';
  });

  const knownSources: SearchSource[] = [
    {
      title: 'Python Tutorial — Official Documentation',
      url: 'https://docs.python.org/3/tutorial/index.html',
      text: 'Python is an easy to learn, powerful programming language.',
    },
    {
      title: 'MDN: JavaScript first steps',
      url: 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps',
      text: 'A variable is a container for a value.',
    },
    {
      title: 'Real Python: CLI applications',
      url: 'https://realpython.com/command-line-interfaces-python-argparse/',
      text: 'Command-line interfaces parse arguments with argparse.',
    },
    {
      title: 'Listicle',
      url: 'https://content-farm.example/listicle',
      text: 'Top 10 Python tricks you never knew!',
    },
  ];

  it('maps fixture verdicts onto the matching sources', async () => {
    const vetted = await vetSources(knownSources);
    expect(vetted).toHaveLength(4);
    const pythonDocs = vetted.find((v) => v.url === 'https://docs.python.org/3/tutorial/index.html');
    expect(pythonDocs?.trusted).toBe(true);
    expect(pythonDocs?.trustReason).toBe('official documentation');
    const mdn = vetted.find((v) => v.url === 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps');
    expect(mdn?.trusted).toBe(true);
    const farm = vetted.find((v) => v.url === 'https://content-farm.example/listicle');
    expect(farm?.trusted).toBe(false);
    expect(farm?.trustReason).toBe('content farm');
  });

  it('defaults to untrusted when a source URL is not in the fixture verdicts', async () => {
    const unknownSource: SearchSource = {
      title: 'Some Unknown Site',
      url: 'https://not-in-fixture.example/article',
      text: 'Some content here.',
    };
    const vetted = await vetSources([unknownSource]);
    expect(vetted).toHaveLength(1);
    expect(vetted[0].trusted).toBe(false);
    expect(vetted[0].trustReason).toBe('no verdict returned');
  });

  it('returns empty array for empty input', async () => {
    const vetted = await vetSources([]);
    expect(vetted).toHaveLength(0);
  });

  it('passes original source fields through', async () => {
    const vetted = await vetSources([knownSources[0]]);
    expect(vetted[0].title).toBe(knownSources[0].title);
    expect(vetted[0].text).toBe(knownSources[0].text);
  });
});
