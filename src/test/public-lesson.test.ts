/**
 * public-lesson.test.ts — Phase 10 Task 3 tests.
 *
 * Test matrix:
 *
 * Unit:
 *  U1. getPublicLesson returns null for unknown slug.
 *  U2. getPublicLesson returns null for 'pending' moderationStatus.
 *  U3. getPublicLesson returns null for 'removed' moderationStatus.
 *  U4. getPublicLesson returns null when URL vertical doesn't match row vertical.
 *  U5. getPublicLesson returns data for approved row with matching vertical.
 *  U6. Returned content has NO correctIndex or explanation fields (answer-key strip).
 *
 * Report endpoint (via createReportHandler + testDb):
 *  R1. Unknown slug → 200 {ok:true}, no alert (anti-oracle).
 *  R2. Invalid reason → 400.
 *  R3. Valid report on approved row → 200, report_count incremented, alert fired.
 *  R4. 3rd report on 'approved' row → status still 'approved' (no auto-flip),
 *      report_count = 3, alertFounder called three times total.
 *  R5. Report on 'removed' row → 200, count NOT incremented, NO alert.
 *  R5b. Report on 'pending' row → 200, count NOT incremented, NO alert.
 *  R6. Rate-limit: 4th report from same IP → 429.
 *  R7. Alert payload is EXACTLY {slug, reason} — no extra keys.
 *
 * Admin queue extension (via createAdminQueueHandlers + real handlers):
 *  A1. GET includes sharedItems with reported + pending rows; excludes clean row.
 *  A2. POST {sharedLessonId, action:'republish'} → 200; DB shows approved + reportCount 0.
 *  A3. POST {sharedLessonId, action:'take_down'} → 200; DB shows removed.
 *  A4. Non-admin session → 404; no-session → 404.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { getPublicLesson } from '@/server/lessons/public-lesson';
import {
  createReportHandler,
  _clearReportRateMap,
} from '@/app/api/shared/[slug]/report/route';
import * as alertsModule from '@/lib/alerts';

// ── Pool lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
});
afterAll(() => testPool.end());
afterEach(() => {
  vi.restoreAllMocks();
  _clearReportRateMap();
});

// ── Seed helpers ───────────────────────────────────────────────────────────────

async function seedWorld(suffix: string) {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'PL-' + suffix, email: `${crypto.randomUUID()}@pl.test` })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'PL-' + suffix, ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Python variables', vertical: 'programming', expertiseBand: 'novice' })
    .returning();
  await testDb.insert(s.missions).values({
    trackId: track.id,
    whyText: 'learn to code',
    successCriteria: [{ description: 'write a working script' }],
    constraints: {},
    outOfScope: [],
  });
  return { u, learner, track };
}

async function seedLesson(trackId: string, seq = 1) {
  const [lesson] = await testDb
    .insert(s.lessons)
    .values({
      trackId,
      seq,
      spec: { objective: 'Declare variables', format: 'article', estimatedMinutes: 8, blockOutline: [] },
      content: {
        blocks: [
          {
            type: 'article',
            heading: 'Variables: names for values',
            markdown: 'A variable stores a value under a name. Variables are fundamental to programming.',
            citationUrls: ['https://docs.python.org/3/'],
          },
          {
            type: 'quiz',
            items: [
              {
                id: 'q1',
                question: 'What does a variable do?',
                options: ['Stores a value', 'Draws on screen', 'Connects to the internet', 'Compiles code'],
                correctIndex: 0,
                explanation: 'A variable is a named container for a value.',
              },
            ],
          },
        ],
        winCheck: {
          items: [
            {
              id: 'wc1',
              question: 'What does a variable do?',
              options: ['Stores a value', 'Draws on screen', 'Connects to net', 'Compiles code'],
              correctIndex: 0,
              explanation: 'A variable is a named container.',
            },
            {
              id: 'wc2',
              question: 'After x = 5 then x = 7, what is x?',
              options: ['7', '5', '12', 'Both'],
              correctIndex: 0,
              explanation: 'Assignment replaces the stored value.',
            },
          ],
        },
      },
      citations: [{ url: 'https://docs.python.org/3/' }],
      zpdSnapshot: {},
      status: 'ready',
      verificationStatus: 'verified',
      faithfulnessScore: 0.9,
    })
    .returning();
  return lesson;
}

async function seedSharedLesson(
  lessonId: string,
  overrides: Partial<typeof s.sharedLessons.$inferInsert> = {},
) {
  const [row] = await testDb
    .insert(s.sharedLessons)
    .values({
      lessonId,
      sanitizedContent: {
        blocks: [
          {
            type: 'article',
            heading: 'Variables: names for values',
            markdown: 'A variable stores a value under a name. Variables are fundamental to programming.',
            citationUrls: ['https://docs.python.org/3/'],
          },
          {
            type: 'quiz',
            items: [
              {
                id: 'q1',
                question: 'What does a variable do?',
                options: ['Stores a value', 'Draws on screen', 'Connects to the internet', 'Compiles code'],
                correctIndex: 0,
                explanation: 'A variable is a named container for a value.',
              },
            ],
          },
        ],
        winCheck: {
          items: [
            {
              id: 'wc1',
              question: 'What does a variable do?',
              options: ['Stores a value', 'Draws on screen', 'Connects to net', 'Compiles code'],
              correctIndex: 0,
              explanation: 'A variable is a named container.',
            },
            {
              id: 'wc2',
              question: 'After x = 5 then x = 7, what is x?',
              options: ['7', '5', '12', 'Both'],
              correctIndex: 0,
              explanation: 'Assignment replaces the stored value.',
            },
          ],
        },
      },
      slug: `python-variables-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      vertical: 'programming',
      moderationStatus: 'approved',
      verificationStatus: 'verified',
      badgeSnapshot: {
        overallStatus: 'verified',
        faithfulnessScore: 0.9,
        checkedAt: new Date().toISOString(),
        blocks: [{ blockId: 'block-0', badge: 'verified' }],
      },
      reportCount: 0,
      ...overrides,
    })
    .returning();
  return row;
}

// ════════════════════════════════════════════════════════════════════════════════
// U1–U6: getPublicLesson unit-style integration tests
// ════════════════════════════════════════════════════════════════════════════════

describe('getPublicLesson', () => {
  it('U1. returns null for unknown slug', async () => {
    const result = await getPublicLesson(testDb, 'programming', 'totally-unknown-slug-00000000');
    expect(result).toBeNull();
  });

  it('U2. returns null for pending moderationStatus', async () => {
    const { track } = await seedWorld('pub-pending');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { moderationStatus: 'pending' });
    const result = await getPublicLesson(testDb, 'programming', shared.slug);
    expect(result).toBeNull();
  });

  it('U3. returns null for removed moderationStatus', async () => {
    const { track } = await seedWorld('pub-removed');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { moderationStatus: 'removed' });
    const result = await getPublicLesson(testDb, 'programming', shared.slug);
    expect(result).toBeNull();
  });

  it('U4. returns null when URL vertical does not match row vertical', async () => {
    const { track } = await seedWorld('pub-vert-mismatch');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { vertical: 'programming' });
    // Request with wrong vertical
    const result = await getPublicLesson(testDb, 'history', shared.slug);
    expect(result).toBeNull();
  });

  it('U5. returns data for approved row with matching vertical', async () => {
    const { track } = await seedWorld('pub-approved');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { moderationStatus: 'approved', vertical: 'programming' });
    const result = await getPublicLesson(testDb, 'programming', shared.slug);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe(shared.slug);
    expect(result!.vertical).toBe('programming');
  });

  it('U6. returned content has NO correctIndex or explanation (answer-key strip)', async () => {
    const { track } = await seedWorld('pub-strip');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { moderationStatus: 'approved' });
    const result = await getPublicLesson(testDb, 'programming', shared.slug);
    expect(result).not.toBeNull();

    // Stringify the content and check that answer key fields are absent
    const contentStr = JSON.stringify(result!.content);
    expect(contentStr).not.toContain('"correctIndex"');
    expect(contentStr).not.toContain('"explanation"');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// R1–R7: Report endpoint
// ════════════════════════════════════════════════════════════════════════════════

describe('report endpoint', () => {
  const handler = createReportHandler(testDb);

  function makeReportRequest(slug: string, body: unknown, ip = '10.0.0.1') {
    return new NextRequest(`http://localhost/api/shared/${slug}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify(body),
    });
  }

  it('R1. unknown slug → 200 {ok:true}, no alert (anti-oracle: must not reveal slug existence)', async () => {
    const alertSpy = vi.spyOn(alertsModule, 'alertFounder');
    const req = makeReportRequest('totally-unknown-00000000', { reason: 'inaccurate' });
    const res = await handler(req, { params: Promise.resolve({ slug: 'totally-unknown-00000000' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    // No alert fired — slug does not exist
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('R2. invalid reason → 400', async () => {
    const { track } = await seedWorld('report-r2');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id);

    const req = makeReportRequest(shared.slug, { reason: 'gibberish' }, '10.0.0.2');
    const res = await handler(req, { params: Promise.resolve({ slug: shared.slug }) });
    expect(res.status).toBe(400);
  });

  it('R3. valid report on approved row → 200, report_count incremented, alert fired', async () => {
    const { track } = await seedWorld('report-r3');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { reportCount: 0 });

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder');

    const req = makeReportRequest(shared.slug, { reason: 'inaccurate' }, '10.0.0.3');
    const res = await handler(req, { params: Promise.resolve({ slug: shared.slug }) });
    expect(res.status).toBe(200);

    const [updated] = await testDb
      .select({ reportCount: s.sharedLessons.reportCount })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    expect(updated.reportCount).toBe(1);
    expect(alertSpy).toHaveBeenCalledOnce();
  });

  it('R4. 3rd report on "approved" row → status still approved (no auto-flip), count=3, three alerts', async () => {
    const { track } = await seedWorld('report-r4');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { reportCount: 0, moderationStatus: 'approved' });

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder');

    // Fire 3 reports from 3 different IPs (so rate-limit doesn't interfere)
    for (let i = 0; i < 3; i++) {
      const req = makeReportRequest(shared.slug, { reason: 'inappropriate' }, `10.1.0.${i}`);
      const res = await handler(req, { params: Promise.resolve({ slug: shared.slug }) });
      expect(res.status).toBe(200);
    }

    const [updated] = await testDb
      .select({
        moderationStatus: s.sharedLessons.moderationStatus,
        reportCount: s.sharedLessons.reportCount,
      })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));

    // Status must NOT have been auto-flipped (decision 2026-06-11)
    expect(updated.moderationStatus).toBe('approved');
    expect(updated.reportCount).toBe(3);
    // All three triggered alerts
    expect(alertSpy).toHaveBeenCalledTimes(3);
  });

  it('R5. report on "removed" row → 200, count NOT incremented, NO alert', async () => {
    const { track } = await seedWorld('report-r5');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { reportCount: 5, moderationStatus: 'removed' });

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder');

    const req = makeReportRequest(shared.slug, { reason: 'other' }, '10.0.0.5');
    const res = await handler(req, { params: Promise.resolve({ slug: shared.slug }) });
    expect(res.status).toBe(200);

    const [updated] = await testDb
      .select({ moderationStatus: s.sharedLessons.moderationStatus, reportCount: s.sharedLessons.reportCount })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    // Status unchanged
    expect(updated.moderationStatus).toBe('removed');
    // Count NOT incremented (no side effects for non-approved rows)
    expect(updated.reportCount).toBe(5);
    // No alert
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('R5b. report on "pending" row → 200, count NOT incremented, NO alert', async () => {
    const { track } = await seedWorld('report-r5b');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { reportCount: 2, moderationStatus: 'pending' });

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder');

    const req = makeReportRequest(shared.slug, { reason: 'inaccurate' }, '10.0.0.8');
    const res = await handler(req, { params: Promise.resolve({ slug: shared.slug }) });
    expect(res.status).toBe(200);

    const [updated] = await testDb
      .select({ reportCount: s.sharedLessons.reportCount })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    expect(updated.reportCount).toBe(2); // unchanged
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('R6. rate-limit: 4th report from same IP within window → 429', async () => {
    const { track } = await seedWorld('report-r6');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id);
    const slug = shared.slug;
    const ip = '10.0.0.6';

    // First 3 allowed
    for (let i = 0; i < 3; i++) {
      const req = makeReportRequest(slug, { reason: 'inaccurate' }, ip);
      const res = await handler(req, { params: Promise.resolve({ slug }) });
      expect(res.status).toBe(200);
    }

    // 4th → 429
    const req = makeReportRequest(slug, { reason: 'inaccurate' }, ip);
    const res = await handler(req, { params: Promise.resolve({ slug }) });
    expect(res.status).toBe(429);
  });

  it('R7. alertFounder payload is EXACTLY {slug, reason} — no extra keys', async () => {
    const { track } = await seedWorld('report-r7');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id);

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder');

    const req = makeReportRequest(shared.slug, { reason: 'copyright' }, '10.0.0.7');
    await handler(req, { params: Promise.resolve({ slug: shared.slug }) });

    expect(alertSpy).toHaveBeenCalledOnce();
    const [kind, payload] = alertSpy.mock.calls[0];
    expect(kind).toBe('report');
    expect(payload).toHaveProperty('slug', shared.slug);
    expect(payload).toHaveProperty('reason', 'copyright');
    // Exact key set — no internal IDs or extra fields
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual(['reason', 'slug']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// A1–A4: Admin queue extension — REAL handlers via createAdminQueueHandlers factory
// ════════════════════════════════════════════════════════════════════════════════

const ADMIN_TEST_EMAIL = 'admin-queue-test@learnanything.test';

describe('admin queue — shared lesson entries (real handlers)', () => {
  beforeAll(async () => {
    await resetDb();
    process.env.ADMIN_EMAILS = ADMIN_TEST_EMAIL;
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function getHandlers() {
    // Mock auth + next/headers before importing the factory so the module uses
    // the mocked versions (same technique as account.test.ts:645-672).
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({
            user: { id: 'admin-test-user', email: ADMIN_TEST_EMAIL },
          }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));
    const { createAdminQueueHandlers } = await import('@/app/api/admin/queue/route');
    const { GET, POST } = createAdminQueueHandlers(testDb);
    return { GET, POST };
  }

  async function getNonAdminHandlers(email = 'hacker@evil.com') {
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({
            user: { id: 'non-admin-user', email },
          }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));
    const { createAdminQueueHandlers } = await import('@/app/api/admin/queue/route');
    const { GET, POST } = createAdminQueueHandlers(testDb);
    return { GET, POST };
  }

  async function getNoSessionHandlers() {
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue(null),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));
    const { createAdminQueueHandlers } = await import('@/app/api/admin/queue/route');
    const { GET, POST } = createAdminQueueHandlers(testDb);
    return { GET, POST };
  }

  it('A1. GET sharedItems includes reported + pending rows; excludes clean row', async () => {
    const { GET } = await getHandlers();

    const { track } = await seedWorld('admin-a1');
    const lesson = await seedLesson(track.id, 1);
    const reported = await seedSharedLesson(lesson.id, { reportCount: 1, moderationStatus: 'approved' });

    const { track: track2 } = await seedWorld('admin-a1b');
    const lesson2 = await seedLesson(track2.id, 1);
    const pending = await seedSharedLesson(lesson2.id, { moderationStatus: 'pending', reportCount: 0 });

    const { track: track3 } = await seedWorld('admin-a1c');
    const lesson3 = await seedLesson(track3.id, 1);
    const clean = await seedSharedLesson(lesson3.id, { moderationStatus: 'approved', reportCount: 0 });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { sharedItems: { id: string }[] };

    const ids = body.sharedItems.map((r) => r.id);
    expect(ids).toContain(reported.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(clean.id);

    vi.resetModules();
  });

  it('A2. POST republish → 200; DB shows approved + reportCount 0', async () => {
    const { POST } = await getHandlers();

    const { track } = await seedWorld('admin-a2');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { moderationStatus: 'pending', reportCount: 3 });

    const req = new NextRequest('http://localhost/api/admin/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLessonId: shared.id, action: 'republish' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const [updated] = await testDb
      .select({
        moderationStatus: s.sharedLessons.moderationStatus,
        reportCount: s.sharedLessons.reportCount,
      })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    expect(updated.moderationStatus).toBe('approved');
    expect(updated.reportCount).toBe(0);

    vi.resetModules();
  });

  it('A3. POST take_down → 200; DB shows removed', async () => {
    const { POST } = await getHandlers();

    const { track } = await seedWorld('admin-a3');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { moderationStatus: 'approved', reportCount: 2 });

    const req = new NextRequest('http://localhost/api/admin/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLessonId: shared.id, action: 'take_down' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const [updated] = await testDb
      .select({ moderationStatus: s.sharedLessons.moderationStatus })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    expect(updated.moderationStatus).toBe('removed');

    vi.resetModules();
  });

  it('A4a. non-admin session email → 404 on POST, row unchanged', async () => {
    const { POST } = await getNonAdminHandlers();

    const { track } = await seedWorld('admin-a4');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { moderationStatus: 'approved', reportCount: 0 });

    const req = new NextRequest('http://localhost/api/admin/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLessonId: shared.id, action: 'take_down' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);

    // Row must be unchanged
    const [after] = await testDb
      .select({ moderationStatus: s.sharedLessons.moderationStatus })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    expect(after.moderationStatus).toBe('approved');

    vi.resetModules();
  });

  it('A4b. no session → 404 on POST', async () => {
    const { POST } = await getNoSessionHandlers();

    const req = new NextRequest('http://localhost/api/admin/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLessonId: 'any-id', action: 'take_down' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);

    vi.resetModules();
  });
});
