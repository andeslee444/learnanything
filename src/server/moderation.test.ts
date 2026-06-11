import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as alertsModule from '@/lib/alerts';

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

// ── age-band: band reaches the system prompt ──────────────────────────────────
// Verifies that the ageBand is appended to the system prompt, and that the
// default (no band) is '13_15' (most conservative).

describe('moderateText — age-band system prompt', () => {
  beforeEach(() => {
    process.env.AI_FAKE_LLM = '0';
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/ai');
    vi.doUnmock('@/lib/alerts');
    process.env.AI_FAKE_LLM = '1';
  });

  it('includes the ageBand POLICY line in the system prompt when band is provided', async () => {
    const capturedSystems: string[] = [];
    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockImplementation(async (opts: { system: string }) => {
        capturedSystems.push(opts.system);
        return { allowed: true, reason: 'ok' };
      }),
    }));
    const { moderateText } = await import('./moderation');
    await moderateText('variables in Python', 'learning_request', { ageBand: '16_17' });
    expect(capturedSystems[0]).toContain('16_17');
    expect(capturedSystems[0]).toContain('POLICY');
  });

  it('defaults to 13_15 (most conservative) when no ageBand provided', async () => {
    const capturedSystems: string[] = [];
    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockImplementation(async (opts: { system: string }) => {
        capturedSystems.push(opts.system);
        return { allowed: true, reason: 'ok' };
      }),
    }));
    const { moderateText } = await import('./moderation');
    await moderateText('variables in Python', 'learning_request');
    // Default band is 13_15 — most conservative
    expect(capturedSystems[0]).toContain('13_15');
  });

  it('calls alertFounder("moderation_flag") when not allowed and not errored', async () => {
    const alertCalls: Array<[string, Record<string, unknown>]> = [];
    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockResolvedValue({ allowed: false, reason: 'blocked content' }),
    }));
    vi.doMock('@/lib/alerts', () => ({
      alertFounder: vi.fn().mockImplementation((kind: string, payload: Record<string, unknown>) => {
        alertCalls.push([kind, payload]);
      }),
    }));
    const { moderateText } = await import('./moderation');
    const result = await moderateText('bad content', 'learning_request', { ageBand: '13_15' });
    expect(result.allowed).toBe(false);
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0][0]).toBe('moderation_flag');
    expect(alertCalls[0][1]).toMatchObject({ context: 'learning_request' });
  });

  it('does NOT call alertFounder when errored=true (transient error, not a flag)', async () => {
    const alertCalls: Array<unknown[]> = [];
    vi.doMock('@/lib/ai', () => ({
      llmObject: vi.fn().mockRejectedValue(new Error('timeout')),
    }));
    vi.doMock('@/lib/alerts', () => ({
      alertFounder: vi.fn().mockImplementation((...args: unknown[]) => {
        alertCalls.push(args);
      }),
    }));
    const { moderateText } = await import('./moderation');
    const result = await moderateText('some text', 'learning_request');
    expect(result.errored).toBe(true);
    expect(alertCalls.length).toBe(0);
  });
});
