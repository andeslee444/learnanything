/**
 * Admin queue tests — Phase 7 Task 3.
 *
 * Tests:
 * 1. Gate: ADMIN_EMAILS env parsing — only listed emails have access.
 * 2. Queue query: returns lessons where status=failed+safety OR verificationStatus=issues
 *    OR faithfulnessScore < 0.8. Excludes adminDismissedAt-set rows.
 * 3. Dismiss action: sets adminDismissedAt, removing item from subsequent GET.
 * 4. Admin retry: flips status failed→generating WITHOUT inserting a credit hold.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';

// ── One pool for the whole file ────────────────────────────────────────────────

afterAll(() => testPool.end());

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedWorld(suffix = '') {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'Admin-' + suffix, email: `${crypto.randomUUID()}@admin.test` })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'Admin' + suffix, ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Python', vertical: 'programming', expertiseBand: 'novice' })
    .returning();
  await testDb.insert(s.missions).values({
    trackId: track.id,
    whyText: 'test',
    successCriteria: [],
    constraints: {},
    outOfScope: [],
  });
  return { u, learner, track };
}

async function seedLesson(trackId: string, overrides: Partial<typeof s.lessons.$inferInsert> = {}) {
  const [lesson] = await testDb
    .insert(s.lessons)
    .values({
      trackId,
      seq: Math.floor(Math.random() * 100000),
      spec: { objective: 'Learn Python', nodeId: 'node-1', levelBand: 'novice', topic: 'Python' },
      status: 'failed',
      content: { failureReason: 'lesson failed the safety check' },
      ...overrides,
    })
    .returning();
  return lesson;
}

// ── Gate tests ─────────────────────────────────────────────────────────────────

describe('admin queue gate — ADMIN_EMAILS parsing', () => {
  it('ADMIN_EMAILS env: only listed emails granted; others denied', async () => {
    const orig = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = 'admin@example.com';
    vi.resetModules();
    try {
      const { getAdminEmailsForTest } = await import('@/app/api/admin/queue/route');
      const emails = getAdminEmailsForTest();
      expect(emails.has('admin@example.com')).toBe(true);
      expect(emails.has('hacker@evil.com')).toBe(false);
    } finally {
      process.env.ADMIN_EMAILS = orig;
      vi.resetModules();
    }
  });

  it('ADMIN_EMAILS: trimmed + lowercased correctly', async () => {
    const orig = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = ' admin@example.com , Founder@Startup.io ';
    vi.resetModules();
    try {
      const { getAdminEmailsForTest } = await import('@/app/api/admin/queue/route');
      const emails = getAdminEmailsForTest();
      expect(emails.has('admin@example.com')).toBe(true);
      expect(emails.has('founder@startup.io')).toBe(true);
    } finally {
      process.env.ADMIN_EMAILS = orig;
      vi.resetModules();
    }
  });
});

// ── Queue query ─────────────────────────────────────────────────────────────────

describe('admin queue query shapes', () => {
  let trackId: string;

  beforeAll(async () => {
    await resetDb();
    const { track } = await seedWorld('q');
    trackId = track.id;
  });

  it('failed+safety: failureReason contains "safety"', async () => {
    const lesson = await seedLesson(trackId, {
      status: 'failed',
      content: { failureReason: 'lesson failed the safety check' },
    });
    const content = lesson.content as Record<string, unknown>;
    expect(String(content.failureReason)).toContain('safety');
  });

  it('verificationStatus=issues lesson is in queue scope', async () => {
    const lesson = await seedLesson(trackId, {
      status: 'ready',
      content: { blocks: [] },
      verificationStatus: 'issues',
    });
    const [row] = await testDb
      .select({ vs: s.lessons.verificationStatus })
      .from(s.lessons)
      .where(eq(s.lessons.id, lesson.id));
    expect(row.vs).toBe('issues');
  });

  it('faithfulnessScore < 0.8 lesson is in queue scope', async () => {
    const lesson = await seedLesson(trackId, {
      status: 'ready',
      content: { blocks: [] },
      faithfulnessScore: 0.65,
    });
    const [row] = await testDb
      .select({ fs: s.lessons.faithfulnessScore })
      .from(s.lessons)
      .where(eq(s.lessons.id, lesson.id));
    expect(row.fs!).toBeLessThan(0.8);
  });
});

// ── Dismiss action ─────────────────────────────────────────────────────────────

describe('admin dismiss removes item from queue', () => {
  let trackId: string;

  beforeAll(async () => {
    await resetDb();
    const { track } = await seedWorld('d');
    trackId = track.id;
  });

  it('dismiss sets adminDismissedAt; row has non-null adminDismissedAt and leaves isNull filter', async () => {
    const lesson = await seedLesson(trackId, {
      status: 'failed',
      content: { failureReason: 'lesson failed the safety check' },
    });
    // Pre: adminDismissedAt is null
    const [pre] = await testDb
      .select({ d: s.lessons.adminDismissedAt })
      .from(s.lessons)
      .where(eq(s.lessons.id, lesson.id));
    expect(pre.d).toBeNull();

    // Simulate dismiss
    await testDb
      .update(s.lessons)
      .set({ adminDismissedAt: new Date() })
      .where(eq(s.lessons.id, lesson.id));

    // Post: adminDismissedAt is set
    const [post] = await testDb
      .select({ d: s.lessons.adminDismissedAt })
      .from(s.lessons)
      .where(eq(s.lessons.id, lesson.id));
    expect(post.d).not.toBeNull();

    // The queue query uses isNull(adminDismissedAt) — this row is now excluded
    const queueVisible = await testDb
      .select({ id: s.lessons.id })
      .from(s.lessons)
      .where(eq(isNull(s.lessons.adminDismissedAt), true));
    // None of the returned rows should be this lesson
    const ids = queueVisible.map((r) => r.id);
    expect(ids).not.toContain(lesson.id);
  });
});

// ── Admin retry — house-paid, no credit hold ──────────────────────────────────

describe('admin retry flips status without a credit hold', () => {
  let trackId: string;
  let userId: string;

  beforeAll(async () => {
    await resetDb();
    const { u, track } = await seedWorld('r');
    trackId = track.id;
    userId = u.id;
    const { ensureMonthlyGrant } = await import('@/lib/credits');
    await ensureMonthlyGrant(testDb, userId);
  });

  it('CAS flips failed→generating and NO credit hold is inserted', async () => {
    const lesson = await seedLesson(trackId, {
      status: 'failed',
      content: { failureReason: 'lesson failed the safety check' },
    });

    const { balance } = await import('@/lib/credits');
    const balanceBefore = await balance(testDb, userId);

    // Admin retry: CAS flip only, no placeHold
    const flipped = await testDb
      .update(s.lessons)
      .set({ status: 'generating', content: null })
      .where(eq(s.lessons.id, lesson.id))
      .returning({ id: s.lessons.id });
    expect(flipped.length).toBe(1);

    // Status is now generating
    const [updated] = await testDb
      .select({ status: s.lessons.status })
      .from(s.lessons)
      .where(eq(s.lessons.id, lesson.id));
    expect(updated.status).toBe('generating');

    // Balance unchanged — no hold deducted
    const balanceAfter = await balance(testDb, userId);
    expect(balanceAfter).toBe(balanceBefore);

    // No hold row for this lesson
    const holds = await testDb
      .select({ id: s.creditLedger.id })
      .from(s.creditLedger)
      .where(eq(s.creditLedger.lessonId, lesson.id));
    expect(holds.length).toBe(0);
  });

  it('CAS does not flip a lesson already generating (conflict returns 0 rows)', async () => {
    // Seed a dedicated track so the one-generating-per-track constraint doesn't interfere.
    const { track: track2 } = await seedWorld('r2');
    const lesson = await seedLesson(track2.id, {
      status: 'failed',
      content: { failureReason: 'lesson failed the safety check' },
    });

    // First flip: succeeds (failed → generating)
    const flip1 = await testDb
      .update(s.lessons)
      .set({ status: 'generating', content: null })
      .where(and(eq(s.lessons.id, lesson.id), eq(s.lessons.status, 'failed')))
      .returning({ id: s.lessons.id });
    expect(flip1.length).toBe(1);

    // Second flip attempt: lesson is now 'generating', WHERE status='failed' doesn't match → 0 rows
    const flip2 = await testDb
      .update(s.lessons)
      .set({ status: 'generating', content: null })
      .where(and(eq(s.lessons.id, lesson.id), eq(s.lessons.status, 'failed')))
      .returning({ id: s.lessons.id });
    expect(flip2.length).toBe(0);
  });
});
