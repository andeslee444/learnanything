import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { eq } from 'drizzle-orm';
import { FakeProvider } from './fake-provider';
import { researchTopic } from './research-topic';

// Top-level module mock — hoisted by Vitest before any imports run.
// Default: pass-through to the real implementation so all other tests are unaffected.
vi.mock('@/server/moderation', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/moderation')>();
  return real;
});

// All tests run with fake AI (no real LLM/embedding calls).
beforeEach(() => {
  process.env.AI_FAKE_LLM = '1';
  vi.restoreAllMocks();
});

// ONE pool end for the whole file.
afterAll(() => testPool.end());

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedAllowlist(vertical: string, domains: string[]) {
  await testDb.insert(s.trustDomains).values(
    domains.map((domain) => ({ vertical, domain, tier: 'tier1' as const, note: 'test' }))
  );
}

async function seedBlocklist(domains: string[]) {
  await testDb.insert(s.trustDomains).values(
    domains.map((domain) => ({ vertical: null, domain, tier: 'blocked' as const, note: 'test' }))
  );
}

// ── Test 1: Cold build ────────────────────────────────────────────────────────

describe('researchTopic — cold build', () => {
  beforeAll(async () => {
    await resetDb();
    await seedAllowlist('programming', ['docs.python.org', 'developer.mozilla.org', 'realpython.com']);
  });

  it('fetches from allowlist, extracts, synthesizes, and persists a dossier', async () => {
    const provider = new FakeProvider();
    const key = { vertical: 'programming', topic: 'python variables intro', levelBand: 'novice' as const };
    const result = await researchTopic(testDb, key, { provider });

    expect(result.status).toBe('built');
    if (result.status !== 'built') throw new Error('expected built');
    expect(result.claims).toBeGreaterThanOrEqual(3);
    expect(result.vettedSources).toBeGreaterThanOrEqual(3);
    expect(result.dossierId).toBeTruthy();

    // Dossier row was persisted.
    const rows = await testDb.select().from(s.topicDossiers).where(eq(s.topicDossiers.id, result.dossierId));
    expect(rows).toHaveLength(1);
    const persistedClaims = rows[0].claims as Array<{ claim: string; sourceUrls: string[] }>;
    expect(persistedClaims.length).toBeGreaterThanOrEqual(3);

    // Every persisted claim's sourceUrls must be a subset of the persisted source urls.
    const persistedSources = rows[0].sources as Array<{ url: string }>;
    const persistedSourceUrlSet = new Set(persistedSources.map((s) => s.url));
    for (const c of persistedClaims) {
      for (const u of c.sourceUrls) {
        expect(persistedSourceUrlSet.has(u)).toBe(true);
      }
    }

    // First (and only) provider call carried includeDomains containing the seeded domains.
    expect(provider.calls).toHaveLength(1);
    const firstCall = provider.calls[0];
    expect(firstCall.includeDomains).toContain('docs.python.org');
    expect(firstCall.includeDomains).toContain('developer.mozilla.org');
    expect(firstCall.includeDomains).toContain('realpython.com');
  });
});

// ── Test 2: Cache hit ─────────────────────────────────────────────────────────
// Depends on the dossier written by the cold-build test — runs WITHOUT resetDb.

describe('researchTopic — cache hit', () => {
  it('returns hit and makes zero provider calls when dossier exists', async () => {
    const freshProvider = new FakeProvider();
    const key = { vertical: 'programming', topic: 'python variables intro', levelBand: 'novice' as const };
    const result = await researchTopic(testDb, key, { provider: freshProvider });

    expect(result.status).toBe('hit');
    expect(freshProvider.calls).toHaveLength(0); // zero provider calls on cache hit
  });
});

// ── Test 3: Insufficient sources ─────────────────────────────────────────────

describe('researchTopic — insufficient sources', () => {
  beforeAll(async () => {
    await resetDb();
    // No allowlist, no blocklist → empty allowlist + empty blocklist.
  });

  it('returns insufficient_sources and persists nothing when provider returns no sources', async () => {
    const provider = new FakeProvider([]); // zero sources returned for both passes
    const key = { vertical: 'programming', topic: 'obscure topic no sources', levelBand: 'novice' as const };
    const result = await researchTopic(testDb, key, { provider });

    expect(result.status).toBe('insufficient_sources');
    if (result.status !== 'insufficient_sources') throw new Error('expected insufficient_sources');
    expect(result.vettedSources).toBe(0);

    // Nothing persisted.
    const rows = await testDb.select().from(s.topicDossiers);
    expect(rows).toHaveLength(0);
  });
});

// ── Test 4: Open-web vetting path ─────────────────────────────────────────────

describe('researchTopic — open-web vetting path', () => {
  beforeAll(async () => {
    await resetDb();
    // Seed one blocked domain. No allowlist for 'history' → pass 1 is skipped.
    await seedBlocklist(['quora.com']);
  });

  it('falls back to open-web pass, vets sources, and carries excludeDomains', async () => {
    const provider = new FakeProvider(); // default fixture sources (all trusted by fixture)
    const key = { vertical: 'history', topic: 'python variables intro', levelBand: 'novice' as const };
    const result = await researchTopic(testDb, key, { provider });

    expect(result.status).toBe('built');

    // Provider should have been called exactly once (pass 2 only — no allowlist → pass 1 skipped).
    expect(provider.calls).toHaveLength(1);

    // That call must carry excludeDomains = the seeded blocklist.
    const openWebCall = provider.calls[0];
    expect(openWebCall.excludeDomains).toContain('quora.com');
    // No includeDomains on the open-web pass.
    expect(openWebCall.includeDomains).toBeUndefined();
  });
});

// ── Test 5: Blocked topic ─────────────────────────────────────────────────────
// Uses vi.spyOn to override moderateText for this test only.
// The top-level vi.mock passes through to the real module, so spyOn can intercept it.

describe('researchTopic — blocked topic', () => {
  beforeAll(resetDb);

  it('returns blocked and makes no provider calls when moderation blocks the topic', async () => {
    // Spy on the module export via the top-level mock's live binding.
    const modModule = await import('@/server/moderation');
    const spy = vi.spyOn(modModule, 'moderateText').mockResolvedValue({
      allowed: false,
      reason: 'blocked by test',
    });

    try {
      const provider = new FakeProvider();
      const key = { vertical: 'programming', topic: 'definitely blocked topic', levelBand: 'novice' as const };
      const result = await researchTopic(testDb, key, { provider });

      expect(result.status).toBe('blocked');
      if (result.status !== 'blocked') throw new Error('expected blocked');
      expect(result.retryable).toBe(false);
      // No provider calls — we never searched.
      expect(provider.calls).toHaveLength(0);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Test 6: Dropped-source citability ─────────────────────────────────────────
// When moderation blocks the retrieved_content check for docs.python.org (the first source),
// that source must NOT appear in the persisted dossier's sources array.
//
// Fixture has 4 claims:
//   A (python.org only) → dropped by citation guard (python.org not in surviving sources)
//   B (python.org + MDN) → MDN survives → kept with [MDN]
//   C (realpython only) → kept
//   D (MDN only) → kept
// Result: 3 claims survive → meets the dossier floor → dossier IS persisted.

describe('researchTopic — dropped-source citability', () => {
  beforeAll(async () => {
    await resetDb();
    // Seed allowlist so all 3 FAKE_SOURCES are pre-trusted (no vetting pass needed).
    await seedAllowlist('programming', ['docs.python.org', 'developer.mozilla.org', 'realpython.com']);
  });

  it('excludes a moderation-dropped source from dossier sources and persists with ≥3 claims', async () => {
    const modModule = await import('@/server/moderation');
    let contentCallCount = 0;
    const spy = vi.spyOn(modModule, 'moderateText').mockImplementation(
      async (_text: string, context: 'learning_request' | 'retrieved_content') => {
        if (context === 'retrieved_content') {
          contentCallCount++;
          // Block only the FIRST extracted source (docs.python.org).
          if (contentCallCount === 1) return { allowed: false, reason: 'flagged by test' };
        }
        return { allowed: true, reason: 'pass-through' };
      }
    );

    try {
      const provider = new FakeProvider();
      const key = { vertical: 'programming', topic: 'python variables dropped source', levelBand: 'novice' as const };
      const result = await researchTopic(testDb, key, { provider });

      // 3 claims survive the citation guard → meets floor → dossier IS persisted.
      expect(result.status).toBe('built');
      if (result.status !== 'built') throw new Error('expected built');
      expect(result.claims).toBeGreaterThanOrEqual(3);

      // The dropped source (docs.python.org) must NOT appear in dossier sources.
      const rows = await testDb.select().from(s.topicDossiers).where(eq(s.topicDossiers.id, result.dossierId));
      expect(rows).toHaveLength(1);
      const dossierSources = rows[0].sources as Array<{ url: string }>;
      const sourceUrls = dossierSources.map((src) => src.url);
      expect(sourceUrls).not.toContain('https://docs.python.org/3/tutorial/index.html');

      // The two surviving sources are present.
      expect(sourceUrls).toContain('https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps');
      expect(sourceUrls).toContain('https://realpython.com/command-line-interfaces-python-argparse/');

      // Every persisted claim's sourceUrls must be a subset of the persisted source urls.
      const persistedSourceUrlSet = new Set(sourceUrls);
      const persistedClaims = rows[0].claims as Array<{ claim: string; sourceUrls: string[] }>;
      expect(persistedClaims.length).toBeGreaterThanOrEqual(3);
      for (const c of persistedClaims) {
        for (const u of c.sourceUrls) {
          expect(persistedSourceUrlSet.has(u)).toBe(true);
        }
      }
    } finally {
      spy.mockRestore();
    }
  });
});
