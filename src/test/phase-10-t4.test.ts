/**
 * Phase 10, Task 4 tests — corrections propagation + regression hook.
 *
 * Test matrix:
 *
 * Regression hook (maybeUnpublishSharedOnRegression):
 *   R1. Approved row + low score → status flips to 'pending' + alert fired (content-free,
 *       exact keys: kind='report', payload has slug + lessonId + note='faithfulness_regression').
 *   R2. Idempotent: already-pending row → no flip, no alert.
 *   R3. Removed row stays removed (sticky), no alert.
 *   R4. No shared row → no-op, no alert.
 *   R5. Approved + healthy score (>=0.8, status='verified') → untouched, no alert.
 *   R6. Approved + issues status (score>=0.8 but verificationStatus='issues') → flips pending.
 *
 * Re-share corrections-propagation (shareLesson idempotent path):
 *   C1. Pending row + healthy source → re-sanitize runs, row updated to 'approved',
 *       fresh badgeSnapshot, sanitize spy called.
 *   C2. Approved row → returned untouched, sanitize NOT called (protects LLM spend).
 *   C3. Pending row + still-unhealthy source → stays pending, sanitize NOT called
 *       (IMPORTANT: unhealthy source must not be re-publishable by the owner).
 *   C4. Removed row → returned untouched, sanitize NOT called.
 *
 * Badge refresh (cheap re-snapshot without re-sanitizing):
 *   B1. Approved row with checkedAt=null + source now has verification rows
 *       → badgeSnapshot refreshed (no sanitize call).
 *   B2. Approved row with checkedAt set → returned untouched even if verification rows exist.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { maybeUnpublishSharedOnRegression } from '@/server/lessons/verdicts';
import { createShareHandlers, _clearShareDebounce, type BadgeSnapshot } from '@/server/lessons/share';
import * as alertsModule from '@/lib/alerts';
import * as sanitizeModule from '@/server/lessons/sanitize';

// ── Pool lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
});
afterAll(() => testPool.end());
afterEach(() => {
  vi.restoreAllMocks();
  _clearShareDebounce();
});

// ── Seed helpers ───────────────────────────────────────────────────────────────

const PYTHON_URL = 'https://docs.python.org/3/tutorial/index.html';
const MDN_URL = 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps';

async function seedWorld(suffix: string) {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'T4-' + suffix, email: `${crypto.randomUUID()}@t4.test` })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'T4-' + suffix, ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Python variables', vertical: 'programming', expertiseBand: 'novice' })
    .returning();
  await testDb.insert(s.missions).values({
    trackId: track.id,
    whyText: 'learn to code',
    successCriteria: [{ description: 'write a script' }],
    constraints: {},
    outOfScope: [],
  });
  return { u, learner, track };
}

function fakeEmbedding(seed: number) {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed * (i + 1)));
}

async function seedDossier(suffix = '') {
  const [dossier] = await testDb
    .insert(s.topicDossiers)
    .values({
      vertical: 'programming',
      topic: 'Python variables ' + suffix,
      levelBand: 'novice',
      embedding: fakeEmbedding(42),
      ttlExpiresAt: new Date(Date.now() + 86_400_000),
      sources: [
        { url: PYTHON_URL, title: 'Python Tutorial' },
        { url: MDN_URL, title: 'MDN' },
      ],
      claims: [
        { claim: 'Variables store values under a name.', sourceUrls: [PYTHON_URL] },
      ],
      misconceptions: [],
      glossarySeeds: [],
    })
    .returning();
  return dossier;
}

async function seedTrustDomains() {
  await testDb.insert(s.trustDomains).values([
    { vertical: 'programming', domain: 'developer.mozilla.org', tier: 'tier1', note: 'test' },
    { vertical: 'programming', domain: 'docs.python.org', tier: 'tier1', note: 'test' },
  ]).onConflictDoNothing();
}

async function seedReadyLesson(
  trackId: string,
  dossierId: string,
  opts: {
    seq?: number;
    verificationStatus?: 'pending' | 'verified' | 'issues';
    faithfulnessScore?: number | null;
  } = {},
) {
  const { seq = 1, verificationStatus = 'verified', faithfulnessScore = 0.9 } = opts;
  const [lesson] = await testDb
    .insert(s.lessons)
    .values({
      trackId,
      seq,
      spec: { objective: 'Declare and use variables', format: 'article', estimatedMinutes: 8, blockOutline: [] },
      content: {
        blocks: [
          {
            type: 'article',
            heading: 'Variables: names for values',
            markdown:
              'A **variable** stores a value under a name so your program can use it later. ' +
              'Variables let the same code work with different values.',
            citationUrls: [PYTHON_URL],
          },
          {
            type: 'quiz',
            items: [
              {
                id: 'q1',
                question: 'What does a variable do?',
                options: ['Stores a value', 'Draws on screen', 'Connects to net', 'Compiles code'],
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
              explanation: 'A variable is a named container for a value.',
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
      citations: [{ url: PYTHON_URL }, { url: MDN_URL }],
      zpdSnapshot: { dossierId },
      status: 'ready',
      verificationStatus,
      faithfulnessScore,
    })
    .returning();
  return lesson;
}

async function seedSharedLesson(
  lessonId: string,
  slug: string,
  moderationStatus: 'pending' | 'approved' | 'removed',
  badgeSnapshot: Record<string, unknown> = {},
) {
  const [row] = await testDb
    .insert(s.sharedLessons)
    .values({
      lessonId,
      sanitizedContent: { blocks: [], winCheck: { items: [] } },
      slug,
      vertical: 'programming',
      moderationStatus,
      verificationStatus: 'pending',
      badgeSnapshot,
    })
    .returning();
  return row;
}

// ════════════════════════════════════════════════════════════════════════════════
// Regression hook tests
// ════════════════════════════════════════════════════════════════════════════════

describe('maybeUnpublishSharedOnRegression — regression hook', () => {
  it('R1: approved row + low score → flips to pending + alert fired (content-free, exact keys)', async () => {
    const { track } = await seedWorld('r1');
    const dossier = await seedDossier('r1');
    const lesson = await seedReadyLesson(track.id, dossier.id, { seq: 1, faithfulnessScore: 0.5, verificationStatus: 'issues' });
    const slug = `regression-r1-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'approved');

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder').mockImplementation(() => {});

    await maybeUnpublishSharedOnRegression(testDb, lesson.id, 0.5, 'issues');

    // Row flipped to pending
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(row.moderationStatus).toBe('pending');

    // Alert fired exactly once with kind='report', content-free payload
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith('report', {
      slug,
      lessonId: lesson.id,
      note: 'faithfulness_regression',
    });
  });

  it('R2: already-pending row → no flip, no alert (idempotent)', async () => {
    const { track } = await seedWorld('r2');
    const dossier = await seedDossier('r2');
    const lesson = await seedReadyLesson(track.id, dossier.id, { seq: 2 });
    const slug = `regression-r2-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'pending');

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder').mockImplementation(() => {});

    await maybeUnpublishSharedOnRegression(testDb, lesson.id, 0.5, 'issues');

    // Still pending — no change
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(row.moderationStatus).toBe('pending');

    // No alert fired (already pending → idempotent)
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('R3: removed row stays removed (sticky), no alert', async () => {
    const { track } = await seedWorld('r3');
    const dossier = await seedDossier('r3');
    const lesson = await seedReadyLesson(track.id, dossier.id, { seq: 3 });
    const slug = `regression-r3-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'removed');

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder').mockImplementation(() => {});

    await maybeUnpublishSharedOnRegression(testDb, lesson.id, 0.5, 'issues');

    // Still removed — sticky
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(row.moderationStatus).toBe('removed');

    // No alert for sticky removed rows
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('R4: no shared row → no-op, no alert', async () => {
    const { track } = await seedWorld('r4');
    const dossier = await seedDossier('r4');
    const lesson = await seedReadyLesson(track.id, dossier.id, { seq: 4 });

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder').mockImplementation(() => {});

    // No shared row seeded
    await maybeUnpublishSharedOnRegression(testDb, lesson.id, 0.5, 'issues');

    // No rows exist — no error, no alert
    const rows = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(rows).toHaveLength(0);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('R5: approved + healthy score (>=0.8, verified) → untouched, no alert', async () => {
    const { track } = await seedWorld('r5');
    const dossier = await seedDossier('r5');
    const lesson = await seedReadyLesson(track.id, dossier.id, { seq: 5, faithfulnessScore: 0.9, verificationStatus: 'verified' });
    const slug = `regression-r5-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'approved');

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder').mockImplementation(() => {});

    await maybeUnpublishSharedOnRegression(testDb, lesson.id, 0.9, 'verified');

    // Still approved — healthy score doesn't trigger
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(row.moderationStatus).toBe('approved');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('R6: approved + issues status (score>=0.8 but verificationStatus=issues) → flips pending', async () => {
    const { track } = await seedWorld('r6');
    const dossier = await seedDossier('r6');
    // Score is OK but status is 'issues' — should still trigger
    const lesson = await seedReadyLesson(track.id, dossier.id, { seq: 6, faithfulnessScore: 0.85, verificationStatus: 'issues' });
    const slug = `regression-r6-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'approved');

    const alertSpy = vi.spyOn(alertsModule, 'alertFounder').mockImplementation(() => {});

    await maybeUnpublishSharedOnRegression(testDb, lesson.id, 0.85, 'issues');

    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(row.moderationStatus).toBe('pending');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith('report', expect.objectContaining({
      slug,
      lessonId: lesson.id,
      note: 'faithfulness_regression',
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Re-share corrections-propagation tests
// ════════════════════════════════════════════════════════════════════════════════

describe('shareLesson — corrections-propagation (re-share idempotent path)', () => {
  it('C1: pending row + healthy source → re-sanitize runs, row approved, fresh badgeSnapshot', async () => {
    await seedTrustDomains();
    const dossier = await seedDossier('c1');
    const { track } = await seedWorld('c1');
    // Healthy source lesson
    const lesson = await seedReadyLesson(track.id, dossier.id, {
      seq: 10,
      verificationStatus: 'verified',
      faithfulnessScore: 0.9,
    });

    // Pre-seed a pending shared row (simulating regression-unpublish or admin unpublish)
    const slug = `corr-c1-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'pending');

    // Spy on sanitizeLessonContent to confirm it's called during re-share
    const sanitizeSpy = vi.spyOn(sanitizeModule, 'sanitizeLessonContent');

    const { shareLesson } = createShareHandlers(testDb);
    const result = await shareLesson(lesson, track);

    // Should return the same slug (alreadyExisted=true)
    expect('slug' in result).toBe(true);
    if (!('slug' in result)) return;
    expect(result.slug).toBe(slug);
    expect(result.alreadyExisted).toBe(true);

    // Sanitize was called (re-sanitize ran for corrections propagation)
    expect(sanitizeSpy).toHaveBeenCalled();

    // Row should now be approved
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(row.moderationStatus).toBe('approved');

    // Fresh badgeSnapshot should be set (not the empty one from seedSharedLesson)
    const snap = row.badgeSnapshot as BadgeSnapshot;
    expect(snap).toBeTruthy();
    expect(typeof snap.overallStatus).toBe('string');
  });

  it('C2: approved row → returned untouched, sanitize NOT called (protects LLM spend)', async () => {
    await seedTrustDomains();
    const dossier = await seedDossier('c2');
    const { track } = await seedWorld('c2');
    const lesson = await seedReadyLesson(track.id, dossier.id, {
      seq: 11,
      verificationStatus: 'verified',
      faithfulnessScore: 0.9,
    });

    const slug = `corr-c2-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'approved');

    const sanitizeSpy = vi.spyOn(sanitizeModule, 'sanitizeLessonContent');

    const { shareLesson } = createShareHandlers(testDb);
    const result = await shareLesson(lesson, track);

    expect('slug' in result).toBe(true);
    if (!('slug' in result)) return;
    expect(result.slug).toBe(slug);

    // Sanitize must NOT have been called — approved rows are returned untouched
    expect(sanitizeSpy).not.toHaveBeenCalled();

    // Row still approved
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(row.moderationStatus).toBe('approved');
  });

  it('C3: pending row + still-unhealthy source → stays pending, sanitize NOT called', async () => {
    await seedTrustDomains();
    const dossier = await seedDossier('c3');
    const { track } = await seedWorld('c3');
    // UNHEALTHY source: low faithfulness score
    const lesson = await seedReadyLesson(track.id, dossier.id, {
      seq: 12,
      verificationStatus: 'issues',
      faithfulnessScore: 0.5,
    });

    const slug = `corr-c3-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'pending');

    const sanitizeSpy = vi.spyOn(sanitizeModule, 'sanitizeLessonContent');

    const { shareLesson } = createShareHandlers(testDb);
    const result = await shareLesson(lesson, track);

    // Returns slug (alreadyExisted) but stays pending
    expect('slug' in result).toBe(true);
    if (!('slug' in result)) return;
    expect(result.slug).toBe(slug);

    // Sanitize must NOT have been called — unhealthy source blocks re-publish
    expect(sanitizeSpy).not.toHaveBeenCalled();

    // Row still pending — unhealthy source must not be re-publishable
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(row.moderationStatus).toBe('pending');
  });

  it('C4: removed row → returned untouched, sanitize NOT called (sticky guard)', async () => {
    await seedTrustDomains();
    const dossier = await seedDossier('c4');
    const { track } = await seedWorld('c4');
    const lesson = await seedReadyLesson(track.id, dossier.id, {
      seq: 13,
      verificationStatus: 'verified',
      faithfulnessScore: 0.9,
    });

    const slug = `corr-c4-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'removed');

    const sanitizeSpy = vi.spyOn(sanitizeModule, 'sanitizeLessonContent');

    const { shareLesson } = createShareHandlers(testDb);
    const result = await shareLesson(lesson, track);

    // Returns slug with alreadyExisted
    expect('slug' in result).toBe(true);
    if (!('slug' in result)) return;
    expect(result.slug).toBe(slug);

    // Sanitize NOT called — removed rows are sticky
    expect(sanitizeSpy).not.toHaveBeenCalled();

    // Row still removed
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    expect(row.moderationStatus).toBe('removed');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Badge refresh tests (cheap re-snapshot without re-sanitizing)
// ════════════════════════════════════════════════════════════════════════════════

describe('shareLesson — cheap badge refresh (no re-sanitize)', () => {
  it('B1: approved row with checkedAt=null + source has verification rows → badge snapshot refreshed', async () => {
    await seedTrustDomains();
    const dossier = await seedDossier('b1');
    const { track } = await seedWorld('b1');
    const lesson = await seedReadyLesson(track.id, dossier.id, {
      seq: 20,
      verificationStatus: 'verified',
      faithfulnessScore: 0.9,
    });

    // Seed an approved row with checkedAt=null snapshot
    const slug = `badge-b1-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'approved', {
      overallStatus: 'pending',
      faithfulnessScore: null,
      checkedAt: null,
      blocks: [],
    });

    // Seed a verification row so source "has" verification data
    await testDb.insert(s.verificationResults).values({
      lessonId: lesson.id,
      blockId: 'block-0',
      status: 'verified',
      claimsTotal: 2,
      claimsVerified: 2,
      details: [],
    }).onConflictDoNothing();

    const sanitizeSpy = vi.spyOn(sanitizeModule, 'sanitizeLessonContent');

    const { shareLesson } = createShareHandlers(testDb);
    const result = await shareLesson(lesson, track);

    // Returns as alreadyExisted
    expect('slug' in result).toBe(true);
    if (!('slug' in result)) return;
    expect(result.slug).toBe(slug);

    // Sanitize NOT called — only badge snapshot refresh (no LLM spend)
    expect(sanitizeSpy).not.toHaveBeenCalled();

    // Badge snapshot should now have checkedAt set (not null) from the verification row
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    const snap = row.badgeSnapshot as BadgeSnapshot;
    expect(snap.checkedAt).not.toBeNull();
    // faithfulnessScore should reflect the lesson's current value
    expect(snap.faithfulnessScore).toBeCloseTo(0.9);
  });

  it('B2: approved row with checkedAt already set → returned untouched even if verification rows exist', async () => {
    await seedTrustDomains();
    const dossier = await seedDossier('b2');
    const { track } = await seedWorld('b2');
    const lesson = await seedReadyLesson(track.id, dossier.id, {
      seq: 21,
      verificationStatus: 'verified',
      faithfulnessScore: 0.9,
    });

    const existingCheckedAt = new Date(Date.now() - 5_000).toISOString();
    const slug = `badge-b2-${Date.now().toString(36)}`;
    await seedSharedLesson(lesson.id, slug, 'approved', {
      overallStatus: 'verified',
      faithfulnessScore: 0.9,
      checkedAt: existingCheckedAt,
      blocks: [{ blockId: 'block-0', badge: 'verified' }],
    });

    // Seed a verification row — should NOT trigger refresh since checkedAt is set
    await testDb.insert(s.verificationResults).values({
      lessonId: lesson.id,
      blockId: 'block-0',
      status: 'verified',
      claimsTotal: 2,
      claimsVerified: 2,
      details: [],
    }).onConflictDoNothing();

    const sanitizeSpy = vi.spyOn(sanitizeModule, 'sanitizeLessonContent');

    const { shareLesson } = createShareHandlers(testDb);
    await shareLesson(lesson, track);

    // Sanitize NOT called
    expect(sanitizeSpy).not.toHaveBeenCalled();

    // Badge snapshot unchanged — checkedAt should still be the original value
    const [row] = await testDb.select().from(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lesson.id));
    const snap = row.badgeSnapshot as BadgeSnapshot;
    expect(snap.checkedAt).toBe(existingCheckedAt);
  });
});
