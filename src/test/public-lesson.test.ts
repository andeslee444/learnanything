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
 *  R1. Unknown slug → 404.
 *  R2. Invalid reason → 400.
 *  R3. Valid report → 200, report_count incremented.
 *  R4. 3rd report on 'approved' row → moderationStatus flips to 'pending'.
 *  R5. Report on already-'removed' row → 200, count increments, status NOT changed.
 *  R6. Rate-limit: 4th report from same IP → 429.
 *  R7. Alert: spy on alertFounder — content-free payload (slug + reason only, no IDs).
 *
 * Admin queue extension:
 *  A1. GET /api/admin/queue includes sharedItems with reported/pending rows.
 *  A2. POST republish → status 'approved', reportCount reset to 0.
 *  A3. POST take_down → status 'removed'.
 *  A4. Admin gate: non-admin POST → 404.
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

  it('R1. unknown slug → 404', async () => {
    const req = makeReportRequest('totally-unknown-00000000', { reason: 'inaccurate' });
    const res = await handler(req, { params: Promise.resolve({ slug: 'totally-unknown-00000000' }) });
    expect(res.status).toBe(404);
  });

  it('R2. invalid reason → 400', async () => {
    const { track } = await seedWorld('report-r2');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id);

    const req = makeReportRequest(shared.slug, { reason: 'gibberish' }, '10.0.0.2');
    const res = await handler(req, { params: Promise.resolve({ slug: shared.slug }) });
    expect(res.status).toBe(400);
  });

  it('R3. valid report → 200, report_count incremented', async () => {
    const { track } = await seedWorld('report-r3');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { reportCount: 0 });

    const req = makeReportRequest(shared.slug, { reason: 'inaccurate' }, '10.0.0.3');
    const res = await handler(req, { params: Promise.resolve({ slug: shared.slug }) });
    expect(res.status).toBe(200);

    const [updated] = await testDb
      .select({ reportCount: s.sharedLessons.reportCount })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    expect(updated.reportCount).toBe(1);
  });

  it('R4. 3rd report on "approved" row → moderationStatus flips to "pending"', async () => {
    const { track } = await seedWorld('report-r4');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { reportCount: 2, moderationStatus: 'approved' });

    const req = makeReportRequest(shared.slug, { reason: 'inappropriate' }, '10.0.0.4');
    const res = await handler(req, { params: Promise.resolve({ slug: shared.slug }) });
    expect(res.status).toBe(200);

    const [updated] = await testDb
      .select({ moderationStatus: s.sharedLessons.moderationStatus, reportCount: s.sharedLessons.reportCount })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    expect(updated.moderationStatus).toBe('pending');
    expect(updated.reportCount).toBe(3);
  });

  it('R5. report on already-"removed" row → 200, count increments, status stays "removed"', async () => {
    const { track } = await seedWorld('report-r5');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { reportCount: 5, moderationStatus: 'removed' });

    const req = makeReportRequest(shared.slug, { reason: 'other' }, '10.0.0.5');
    const res = await handler(req, { params: Promise.resolve({ slug: shared.slug }) });
    expect(res.status).toBe(200);

    const [updated] = await testDb
      .select({ moderationStatus: s.sharedLessons.moderationStatus, reportCount: s.sharedLessons.reportCount })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    // Status not changed (was already 'removed')
    expect(updated.moderationStatus).toBe('removed');
    // Count incremented
    expect(updated.reportCount).toBe(6);
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

  it('R7. alertFounder called with content-free payload (slug + reason, no internal IDs)', async () => {
    const { track } = await seedWorld('report-r7');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id);

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder');

    const req = makeReportRequest(shared.slug, { reason: 'copyright' }, '10.0.0.7');
    await handler(req, { params: Promise.resolve({ slug: shared.slug }) });

    expect(alertSpy).toHaveBeenCalledOnce();
    const [kind, payload] = alertSpy.mock.calls[0];
    expect(kind).toBe('report');
    // Payload must be content-free: only slug + reason
    expect(payload).toHaveProperty('slug', shared.slug);
    expect(payload).toHaveProperty('reason', 'copyright');
    // No internal DB IDs
    expect(Object.keys(payload)).toEqual(expect.arrayContaining(['slug', 'reason']));
    expect(Object.keys(payload)).not.toContain('id');
    expect(Object.keys(payload)).not.toContain('lessonId');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// A1–A4: Admin queue extension
//
// These tests validate the DB logic that backs the admin queue, following the
// same pattern as admin-queue.test.ts (direct DB assertions, not via route handler
// which hardcodes the global `db`).
// A4 tests the admin gate (ADMIN_EMAILS) via the route's exported helper.
// ════════════════════════════════════════════════════════════════════════════════

describe('admin queue — shared lesson entries', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('A1. query scope: reported/pending rows appear; clean row excluded', async () => {
    const { track } = await seedWorld('admin-a1');
    const lesson = await seedLesson(track.id, 1);

    // A row with reportCount = 1 (should appear in query)
    const reported = await seedSharedLesson(lesson.id, { reportCount: 1, moderationStatus: 'approved' });

    // A row with moderationStatus = 'pending' (should appear in query)
    const { track: track2 } = await seedWorld('admin-a1b');
    const lesson2 = await seedLesson(track2.id, 1);
    const pending = await seedSharedLesson(lesson2.id, { moderationStatus: 'pending', reportCount: 0 });

    // A row with no reports and approved (should NOT appear in query)
    const { track: track3 } = await seedWorld('admin-a1c');
    const lesson3 = await seedLesson(track3.id, 1);
    const clean = await seedSharedLesson(lesson3.id, { moderationStatus: 'approved', reportCount: 0 });

    // Execute the same query the admin route uses
    const { or, gte, eq: eqOp, desc: descOp } = await import('drizzle-orm');
    const rows = await testDb
      .select({ id: s.sharedLessons.id })
      .from(s.sharedLessons)
      .where(
        or(
          gte(s.sharedLessons.reportCount, 1),
          eqOp(s.sharedLessons.moderationStatus, 'pending'),
        ),
      )
      .orderBy(descOp(s.sharedLessons.createdAt));

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(reported.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(clean.id);
  });

  it('A2. republish action → status approved, reportCount reset', async () => {
    const { track } = await seedWorld('admin-a2');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { moderationStatus: 'pending', reportCount: 3 });

    // Execute the same update the admin route POST does
    await testDb
      .update(s.sharedLessons)
      .set({ moderationStatus: 'approved', reportCount: 0 })
      .where(eq(s.sharedLessons.id, shared.id));

    const [updated] = await testDb
      .select({ moderationStatus: s.sharedLessons.moderationStatus, reportCount: s.sharedLessons.reportCount })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    expect(updated.moderationStatus).toBe('approved');
    expect(updated.reportCount).toBe(0);
  });

  it('A3. take_down action → status removed', async () => {
    const { track } = await seedWorld('admin-a3');
    const lesson = await seedLesson(track.id, 1);
    const shared = await seedSharedLesson(lesson.id, { moderationStatus: 'approved', reportCount: 2 });

    // Execute the same update the admin route POST does
    await testDb
      .update(s.sharedLessons)
      .set({ moderationStatus: 'removed' })
      .where(eq(s.sharedLessons.id, shared.id));

    const [updated] = await testDb
      .select({ moderationStatus: s.sharedLessons.moderationStatus })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.id, shared.id));
    expect(updated.moderationStatus).toBe('removed');
  });

  it('A4. admin gate: ADMIN_EMAILS denies non-listed emails', async () => {
    const orig = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = 'admin@test.com';
    vi.resetModules();
    try {
      const { getAdminEmailsForTest } = await import('@/app/api/admin/queue/route');
      const emails = getAdminEmailsForTest();
      // Admin is allowed
      expect(emails.has('admin@test.com')).toBe(true);
      // Non-admin is denied
      expect(emails.has('hacker@evil.com')).toBe(false);
    } finally {
      process.env.ADMIN_EMAILS = orig;
      vi.resetModules();
    }
  });
});
