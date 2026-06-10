import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── fake mode: allowed ────────────────────────────────────────────────────────

describe('moderateText (fake mode)', () => {
  beforeEach(() => {
    process.env.AI_FAKE_LLM = '1';
  });

  it('returns allowed=true for any text when AI_FAKE_LLM=1', async () => {
    const { moderateText } = await import('./moderation');
    const result = await moderateText('Python programming for beginners', 'learning_request');
    expect(result.allowed).toBe(true);
    expect(result.errored).toBeFalsy();
  });

  it('accepts retrieved_content context', async () => {
    const { moderateText } = await import('./moderation');
    const result = await moderateText('Variables store values under a name.', 'retrieved_content');
    expect(result.allowed).toBe(true);
  });
});

// ── error path: llmObject throws → fail closed with errored=true ──────────────
// Uses vi.doMock (not hoisted) + vi.resetModules() to isolate from the fake-mode tests above.

describe('moderateText (error path)', () => {
  beforeEach(async () => {
    process.env.AI_FAKE_LLM = '0';
    vi.resetModules(); // clear the module cache so doMock takes effect
    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockRejectedValue(new Error('gateway unavailable')),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/ai');
    process.env.AI_FAKE_LLM = '1';
  });

  it('returns {allowed:false, errored:true} when llmObject throws', async () => {
    // Re-import AFTER doMock + resetModules so moderation.ts picks up the mocked @/lib/ai
    const { moderateText } = await import('./moderation');
    const result = await moderateText('some text', 'learning_request');
    expect(result.allowed).toBe(false);
    expect(result.errored).toBe(true);
    expect(result.reason).toBe('moderation unavailable');
  });
});
