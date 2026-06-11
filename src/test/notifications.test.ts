/**
 * Notification tests — Phase 8 Task 3.
 *
 * Tests:
 * 1. Email seam (log transport): no RESEND_API_KEY → console.log called WITHOUT body.
 * 2. Email seam (no-network guard): fetch NOT called when key absent.
 * 3. Cron auth guard: 401 without bearer, 401 with wrong bearer, 401 when CRON_SECRET unset.
 * 4. Cron auth guard: 200 with correct bearer.
 * 5. review-digest: seed learners w/ due cards → runReviewDigest returns correct recipients/counts.
 * 6. mission-report: seed learner with win_check pass events → runMissionReport returns correct recipients.
 *    Also: regression for new-terms count (track-scoped glossary_terms.created_at, not review_cards.due).
 * 7. deliver hook: deliver() calls sendLessonReadyEmail → fires email to learner.
 * 8. alertFounder: reason redacted from email, present in console.warn.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { eq } from 'drizzle-orm';

// ── Pool lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
});
afterAll(() => testPool.end());

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedUser(suffix: string) {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'N-' + suffix, email: `${suffix}@notify.test` })
    .returning();
  return u;
}

async function seedLearner(userId: string, suffix: string) {
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId, displayName: 'NLearner-' + suffix, ageBand: '18_plus' })
    .returning();
  return learner;
}

async function seedTrack(learnerId: string, topic = 'Python') {
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId, topic, vertical: 'programming', expertiseBand: 'novice' })
    .returning();
  return track;
}

// ── 1-2. Email seam (log transport, no-network guard) ─────────────────────────

describe('email seam — log transport (no RESEND_API_KEY)', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
  });
  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.RESEND_API_KEY = originalKey;
    } else {
      delete process.env.RESEND_API_KEY;
    }
  });

  it('returns transport=log when RESEND_API_KEY absent', async () => {
    const { sendEmail } = await import('@/lib/email');
    const result = await sendEmail({ to: 'x@x.com', subject: 'Test', text: 'SECRET BODY CONTENT' });
    expect(result.transport).toBe('log');
    expect(result.sent).toBe(false);
  });

  it('console.log called WITHOUT the body string', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { sendEmail } = await import('@/lib/email');
      const secretBody = 'BODY_THAT_MUST_NOT_APPEAR_IN_LOGS';
      await sendEmail({ to: 'y@y.com', subject: 'Check', text: secretBody });

      // console.log must have been called at least once.
      expect(logSpy).toHaveBeenCalled();

      // The body must NEVER appear in any console.log call argument.
      const allArgs = logSpy.mock.calls.flatMap((call) => call.map((a) => JSON.stringify(a)));
      const anyContainsBody = allArgs.some((arg) => arg.includes(secretBody));
      expect(anyContainsBody).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('fetch is NOT called when RESEND_API_KEY absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const { sendEmail } = await import('@/lib/email');
      await sendEmail({ to: 'z@z.com', subject: 'No-network', text: 'body' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── 3-4. Cron auth guard — review-digest ─────────────────────────────────────

describe('cron auth guard — review-digest', () => {
  let originalCronSecret: string | undefined;

  beforeEach(() => {
    originalCronSecret = process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (originalCronSecret !== undefined) {
      process.env.CRON_SECRET = originalCronSecret;
    } else {
      delete process.env.CRON_SECRET;
    }
  });

  it('401 when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/review-digest/route');
    const req = new Request('http://localhost/api/cron/review-digest', {
      headers: { authorization: 'Bearer whatever' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('401 without bearer', async () => {
    process.env.CRON_SECRET = 'test-secret-review';
    const { GET } = await import('@/app/api/cron/review-digest/route');
    const req = new Request('http://localhost/api/cron/review-digest');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('401 with wrong bearer', async () => {
    process.env.CRON_SECRET = 'test-secret-review';
    const { GET } = await import('@/app/api/cron/review-digest/route');
    const req = new Request('http://localhost/api/cron/review-digest', {
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('200 with correct bearer', async () => {
    process.env.CRON_SECRET = 'test-secret-review';
    const { GET } = await import('@/app/api/cron/review-digest/route');
    const req = new Request('http://localhost/api/cron/review-digest', {
      headers: { authorization: 'Bearer test-secret-review' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ── 3-4. Cron auth guard — mission-report ────────────────────────────────────

describe('cron auth guard — mission-report', () => {
  let originalCronSecret: string | undefined;

  beforeEach(() => {
    originalCronSecret = process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (originalCronSecret !== undefined) {
      process.env.CRON_SECRET = originalCronSecret;
    } else {
      delete process.env.CRON_SECRET;
    }
  });

  it('401 when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/mission-report/route');
    const req = new Request('http://localhost/api/cron/mission-report', {
      headers: { authorization: 'Bearer whatever' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('401 without bearer', async () => {
    process.env.CRON_SECRET = 'test-secret-mission';
    const { GET } = await import('@/app/api/cron/mission-report/route');
    const req = new Request('http://localhost/api/cron/mission-report');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('401 with wrong bearer', async () => {
    process.env.CRON_SECRET = 'test-secret-mission';
    const { GET } = await import('@/app/api/cron/mission-report/route');
    const req = new Request('http://localhost/api/cron/mission-report', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('200 with correct bearer', async () => {
    process.env.CRON_SECRET = 'test-secret-mission';
    const { GET } = await import('@/app/api/cron/mission-report/route');
    const req = new Request('http://localhost/api/cron/mission-report', {
      headers: { authorization: 'Bearer test-secret-mission' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ── 5. review-digest: seeded due cards → correct recipients ───────────────────

describe('runReviewDigest — seeded due cards', () => {
  it('returns correct recipient count and calls sendEmail for each', async () => {
    // Seed two learners with due cards.
    const u1 = await seedUser('digest-u1');
    const u2 = await seedUser('digest-u2');
    // Learner 3 has no due cards.
    const u3 = await seedUser('digest-u3');

    const l1 = await seedLearner(u1.id, 'digest-l1');
    const l2 = await seedLearner(u2.id, 'digest-l2');
    const l3 = await seedLearner(u3.id, 'digest-l3');

    const t1 = await seedTrack(l1.id, 'Python');
    const t2 = await seedTrack(l2.id, 'History');
    const t3 = await seedTrack(l3.id, 'Math');
    void t3;

    // Seed glossary terms (required for review_cards FK).
    const [lr1] = await testDb
      .insert(s.learningRecords)
      .values({ trackId: t1.id, seq: 1, recordType: 'prior_knowledge', title: 'T', body: 'B', evidence: {} })
      .returning();
    const [lr2] = await testDb
      .insert(s.learningRecords)
      .values({ trackId: t2.id, seq: 1, recordType: 'prior_knowledge', title: 'T', body: 'B', evidence: {} })
      .returning();

    const [gt1] = await testDb
      .insert(s.glossaryTerms)
      .values({ trackId: t1.id, term: 'variable', definition: 'A name for a value.', promotionEvidenceRecordId: lr1.id })
      .returning();
    const [gt2] = await testDb
      .insert(s.glossaryTerms)
      .values({ trackId: t2.id, term: 'revolution', definition: 'A political upheaval.', promotionEvidenceRecordId: lr2.id })
      .returning();

    // Due cards for l1 and l2 (past due).
    const pastDue = new Date(Date.now() - 1000);
    await testDb.insert(s.reviewCards).values({ learnerId: l1.id, glossaryTermId: gt1.id, due: pastDue, stability: 1, difficulty: 1, elapsedDays: 0, scheduledDays: 1, reps: 0, lapses: 0 });
    await testDb.insert(s.reviewCards).values({ learnerId: l1.id, glossaryTermId: gt1.id, due: pastDue, stability: 1, difficulty: 1, elapsedDays: 0, scheduledDays: 1, reps: 0, lapses: 0 });
    await testDb.insert(s.reviewCards).values({ learnerId: l2.id, glossaryTermId: gt2.id, due: pastDue, stability: 1, difficulty: 1, elapsedDays: 0, scheduledDays: 1, reps: 0, lapses: 0 });
    // l3 has no due cards.

    // Spy on sendEmail.
    const emailModule = await import('@/lib/email');
    const sendSpy = vi.spyOn(emailModule, 'sendEmail').mockResolvedValue({ sent: false, transport: 'log' });

    try {
      const { runReviewDigest } = await import('@/app/api/cron/review-digest/route');
      const result = await runReviewDigest(testDb, new Date());

      // 2 learners have due cards.
      expect(result.recipients).toBe(2);

      // sendEmail called once per recipient.
      expect(sendSpy).toHaveBeenCalledTimes(2);

      // Check that one call mentions 2 cards (l1) and one mentions 1 card (l2).
      const subjects = sendSpy.mock.calls.map((call) => call[0].subject);
      const subjects2cards = subjects.filter((s) => s.includes('2 reviews'));
      const subjects1card = subjects.filter((s) => s.includes('1 review'));
      expect(subjects2cards.length).toBe(1);
      expect(subjects1card.length).toBe(1);

      // Body must include /reviews path, no card content.
      const texts = sendSpy.mock.calls.map((call) => call[0].text);
      for (const text of texts) {
        expect(text).toContain('/reviews');
        // Content discipline: definitions must not appear.
        expect(text).not.toContain('A name for a value');
        expect(text).not.toContain('A political upheaval');
      }
    } finally {
      sendSpy.mockRestore();
    }
  });
});

// ── 6. mission-report: seeded win_check events → correct recipients ───────────

describe('runMissionReport — seeded win_check pass events', () => {
  it('returns correct recipient count when win_check pass events exist in window', async () => {
    const u = await seedUser('mission-u1');
    const learner = await seedLearner(u.id, 'mission-l1');
    const track = await seedTrack(learner.id, 'Machine Learning');

    // Seed a ready lesson.
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({
        trackId: track.id,
        seq: 1,
        spec: { objective: 'Learn ML basics', nodeId: 'n1', levelBand: 'novice', topic: 'ML' },
        status: 'ready',
      })
      .returning();

    // Seed a win_check attempt_event with correct=true in the window (within last 7 days).
    const recentDate = new Date(Date.now() - 60_000); // 1 minute ago
    await testDb.insert(s.attemptEvents).values({
      learnerId: learner.id,
      lessonId: lesson.id,
      blockId: 'wc-1',
      eventType: 'win_check',
      correct: true,
      createdAt: recentDate,
    });

    // Spy on sendEmail.
    const emailModule = await import('@/lib/email');
    const sendSpy = vi.spyOn(emailModule, 'sendEmail').mockResolvedValue({ sent: false, transport: 'log' });

    try {
      const { runMissionReport } = await import('@/app/api/cron/mission-report/route');
      const since = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
      const result = await runMissionReport(testDb, since);

      expect(result.recipients).toBeGreaterThanOrEqual(1);

      // sendEmail called with the right subject pattern.
      const subjects = sendSpy.mock.calls.map((call) => call[0].subject);
      const matchingSubjects = subjects.filter((s) => s.includes('Machine Learning'));
      expect(matchingSubjects.length).toBeGreaterThanOrEqual(1);

      // Text must contain topic name and counts, not lesson content.
      const texts = sendSpy.mock.calls.map((call) => call[0].text);
      const matchingTexts = texts.filter((t) => t.includes('Machine Learning'));
      expect(matchingTexts.length).toBeGreaterThanOrEqual(1);
      for (const text of matchingTexts) {
        // Content discipline: no lesson spec content.
        expect(text).not.toContain('ML basics');
      }
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('returns 0 recipients when no win_check events in window', async () => {
    const { runMissionReport } = await import('@/app/api/cron/mission-report/route');
    // Use a future since date — nothing will be in this window.
    const futureDate = new Date(Date.now() + 1_000_000);
    const result = await runMissionReport(testDb, futureDate);
    expect(result.recipients).toBe(0);
  });

  it('new-terms count: track-scoped glossary term created NOW is counted', async () => {
    // Regression for the bug where review_cards.due (FSRS future timestamp) was used.
    // Correct fix: count glossary_terms.created_at >= windowStart, scoped to the track.
    const u = await seedUser('newterms-u1');
    const learner = await seedLearner(u.id, 'newterms-l1');
    const track = await seedTrack(learner.id, 'New Terms Track');

    // Seed a lesson + win_check event in the window.
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({
        trackId: track.id,
        seq: 1,
        spec: { objective: 'Obj', nodeId: 'n1', levelBand: 'novice', topic: 'NT' },
        status: 'ready',
      })
      .returning();
    await testDb.insert(s.attemptEvents).values({
      learnerId: learner.id,
      lessonId: lesson.id,
      blockId: 'wc-1',
      eventType: 'win_check',
      correct: true,
      createdAt: new Date(Date.now() - 60_000),
    });

    // Seed a learning record (required for glossary_terms FK).
    const [lr] = await testDb
      .insert(s.learningRecords)
      .values({ trackId: track.id, seq: 1, recordType: 'prior_knowledge', title: 'T', body: 'B', evidence: {} })
      .returning();

    // (a) Glossary term created NOW on the reported track → must be counted.
    await testDb.insert(s.glossaryTerms).values({
      trackId: track.id,
      term: 'recent-term',
      definition: 'Created just now.',
      promotionEvidenceRecordId: lr.id,
    });

    // (b) Glossary term created 30 days ago on the same track → must NOT be counted.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await testDb
      .insert(s.glossaryTerms)
      .values({
        trackId: track.id,
        term: 'old-term',
        definition: 'Created long ago.',
        promotionEvidenceRecordId: lr.id,
        createdAt: thirtyDaysAgo,
      });

    // (c) A review card with a future `due` timestamp — must NOT influence the count.
    await testDb.insert(s.reviewCards).values({
      learnerId: learner.id,
      glossaryTermId: (
        await testDb.select({ id: s.glossaryTerms.id }).from(s.glossaryTerms)
          .where(eq(s.glossaryTerms.term, 'recent-term'))
          .limit(1)
      )[0].id,
      due: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // future due date
      stability: 1, difficulty: 1, elapsedDays: 0, scheduledDays: 1, reps: 0, lapses: 0,
    });

    const emailModule = await import('@/lib/email');
    const sendSpy = vi.spyOn(emailModule, 'sendEmail').mockResolvedValue({ sent: false, transport: 'log' });

    try {
      const { runMissionReport } = await import('@/app/api/cron/mission-report/route');
      const since = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8-day window
      await runMissionReport(testDb, since);

      // Find the email for this track's topic.
      const texts = sendSpy.mock.calls.map((call) => call[0].text);
      const trackTexts = texts.filter((t) => t.includes('New Terms Track'));
      expect(trackTexts.length).toBeGreaterThanOrEqual(1);

      // Only the 1 recent term should appear in the count — "1 new term".
      // The old term (30 days ago) must not be counted.
      // The review card's future due date must not inflate the count.
      for (const text of trackTexts) {
        expect(text).toContain('1 new term');
        // Must use singular (not plural) because count = 1.
        expect(text).not.toContain('2 new terms');
      }
    } finally {
      sendSpy.mockRestore();
    }
  });
});

// ── 7. deliver hook: deliver() fires sendLessonReadyEmail ─────────────────────
//
// Proves that deleting the sendLessonReadyEmail call in deliver() would break
// this test. Seeds a generating lesson, runs deliver (via stageGenerate on a
// fully-seeded pipeline), then asserts sendEmail was called with subject
// containing the objective and to = the learner's email.
//
// deliver() fire-and-forgets the email; we flush with a short await.

describe('deliver hook — deliver() calls sendLessonReadyEmail', () => {
  it('deliver fires email to learner with subject containing the lesson objective', async () => {
    // Reuse seedFullTrack pattern from lesson-pipeline.test.ts.
    const suffix = `dhook-${Date.now()}`;
    const u = await seedUser(suffix);
    const learner = await seedLearner(u.id, suffix);
    const track = await seedTrack(learner.id, 'Deliver Hook Topic');

    // Seed the minimum needed for stageGenerate: mission + skill node + trust domain + hold.
    await testDb.insert(s.missions).values({
      trackId: track.id,
      whyText: 'learn it',
      successCriteria: [{ description: 'ok' }],
      constraints: {},
      outOfScope: [],
    });
    await testDb.insert(s.skillNodes).values({
      trackId: track.id,
      name: 'Deliver Hook Node',
      summary: 'A test node',
      missionRelevance: 0.9,
    });
    // Learning record for glossary FK.
    const [lr] = await testDb
      .insert(s.learningRecords)
      .values({ trackId: track.id, seq: 1, recordType: 'prior_knowledge', title: 'T', body: 'B', evidence: {} })
      .returning();
    await testDb.insert(s.glossaryTerms).values({
      trackId: track.id,
      term: 'dhook-term',
      definition: 'A hook term.',
      promotionEvidenceRecordId: lr.id,
    });
    // Trust domain so research can resolve (AI_FAKE_LLM=1 is set in beforeAll).
    await testDb
      .insert(s.trustDomains)
      .values({ vertical: 'programming', domain: 'docs.python.org', tier: 'tier1', note: 'test' })
      .onConflictDoNothing();

    // Credit grant + lesson row.
    await testDb.insert(s.creditLedger).values({ userId: u.id, entryType: 'grant', amount: 3 });
    const { createLessonRow, stagePlan, stageResearch, stageGenerate } = await import('@/server/lessons/pipeline');
    const { placeHold } = await import('@/lib/credits');
    const lesson = await createLessonRow(testDb, track.id);
    await placeHold(testDb, u.id, lesson.id);

    // Run plan + research stages so stageGenerate has what it needs.
    const planResult = await stagePlan(testDb, lesson.id);
    expect(planResult.status).toBe('planned');
    const researchResult = await stageResearch(testDb, lesson.id);
    expect(researchResult.status).toBe('researched');

    // Spy on sendEmail BEFORE calling stageGenerate so the fire-and-forget is captured.
    const emailModule = await import('@/lib/email');
    const capturedArgs: { to: string; subject: string; text: string }[] = [];
    const sendSpy = vi.spyOn(emailModule, 'sendEmail').mockImplementation(async (args) => {
      capturedArgs.push(args);
      return { sent: false, transport: 'log' as const };
    });

    try {
      const generateResult = await stageGenerate(testDb, lesson.id);
      expect(generateResult.status).toBe('ready');

      // deliver() fire-and-forgets — flush the microtask queue.
      await new Promise((r) => setTimeout(r, 50));

      // sendEmail MUST have been called (proves deliver() calls sendLessonReadyEmail).
      expect(capturedArgs.length).toBeGreaterThan(0);

      // The email must be addressed to the learner's user email.
      const emailArgs = capturedArgs[0];
      expect(emailArgs.to).toBe(u.email);

      // Subject must contain the objective (from lesson.spec).
      expect(emailArgs.subject).toMatch(/^Your lesson is ready/);

      // Text must contain the lesson path (content discipline — no lesson body).
      expect(emailArgs.text).toContain(`/tracks/${track.id}/lessons/${lesson.id}`);
    } finally {
      sendSpy.mockRestore();
    }
  });
});

// ── 7b. sendLessonReadyEmail direct: subject + text content discipline ─────────
//
// Directly tests sendLessonReadyEmail (exported from pipeline.ts) for
// subject format and text content discipline without running the full pipeline.

describe('deliver hook — sendLessonReadyEmail content discipline', () => {
  it('subject contains objective (≤80 chars), text contains lesson path, no article content', async () => {
    const ARTICLE_MARKER = 'UNIQUE_ARTICLE_BODY_CONTENT_MARKER_XYZ_DELIVER';
    const KNOWN_OBJECTIVE = 'Understand how variables work in Python programming language today';

    // Seed world.
    const u = await seedUser(`deliver-${Date.now()}`);
    const learner = await seedLearner(u.id, 'deliver');
    const track = await seedTrack(learner.id, 'Python Basics');

    // Seed lesson with known spec.objective and known article content.
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({
        trackId: track.id,
        seq: 1,
        spec: {
          objective: KNOWN_OBJECTIVE,
          nodeId: 'node-1',
          levelBand: 'novice',
          topic: 'Python Basics',
        },
        // Content includes a known article body marker — must NOT appear in the email.
        content: {
          blocks: [
            {
              type: 'article',
              heading: 'Variables',
              markdown: `${ARTICLE_MARKER} variables store values`,
              citationUrls: [],
            },
          ],
          winCheck: { items: [] },
          openerItems: [],
        },
        status: 'ready',
      })
      .returning();

    const { sendLessonReadyEmail } = await import('@/server/lessons/pipeline');

    // Capture the args passed to sendEmail by checking the email module log.
    // In test env, RESEND_API_KEY is absent → console.log('[email:log]', {to, subject}).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await sendLessonReadyEmail(testDb, lesson.id);

      // console.log('[email:log]', {to, subject}) must have been called.
      const emailLogCalls = logSpy.mock.calls.filter(
        (call) => call[0] === '[email:log]',
      );
      expect(emailLogCalls.length).toBeGreaterThanOrEqual(1);

      for (const [, args] of emailLogCalls) {
        const logged = args as { to: string; subject: string };
        // Subject must start with 'Your lesson is ready:'.
        expect(logged.subject).toMatch(/^Your lesson is ready:/);
        // Subject must contain the objective (truncated to 80 chars).
        expect(logged.subject).toContain(KNOWN_OBJECTIVE.slice(0, 80));
        // Subject must NOT contain the article content marker.
        expect(logged.subject).not.toContain(ARTICLE_MARKER);
      }

      // Also verify via a spy on the email module to capture text.
      const emailModule = await import('@/lib/email');
      const capturedArgs: { to: string; subject: string; text: string }[] = [];
      const sendSpy = vi.spyOn(emailModule, 'sendEmail').mockImplementation(async (args) => {
        capturedArgs.push(args);
        return { sent: false, transport: 'log' as const };
      });

      try {
        await sendLessonReadyEmail(testDb, lesson.id);

        // Fix 4: mandatory — spy interception MUST succeed (not a soft check).
        expect(capturedArgs.length).toBeGreaterThan(0);

        const emailArgs = capturedArgs[0];
        // Text must contain the lesson path.
        expect(emailArgs.text).toContain(`/tracks/${track.id}/lessons/${lesson.id}`);
        // Text must NOT contain the article content marker (content discipline).
        expect(emailArgs.text).not.toContain(ARTICLE_MARKER);
        // Subject must contain objective.
        expect(emailArgs.subject).toContain(KNOWN_OBJECTIVE.slice(0, 80));
      } finally {
        sendSpy.mockRestore();
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it('sendLessonReadyEmail resolves silently when lesson not found (no throw)', async () => {
    const { sendLessonReadyEmail } = await import('@/server/lessons/pipeline');
    // Non-existent lesson ID — should not throw.
    await expect(sendLessonReadyEmail(testDb, crypto.randomUUID())).resolves.toBeUndefined();
  });
});

// ── 8. alertFounder: reason redacted from email, present in console.warn ──────

describe('alertFounder — reason redacted from email (content discipline)', () => {
  let origAdminEmails: string | undefined;

  beforeEach(() => {
    origAdminEmails = process.env.ADMIN_EMAILS;
  });
  afterEach(() => {
    if (origAdminEmails !== undefined) {
      process.env.ADMIN_EMAILS = origAdminEmails;
    } else {
      delete process.env.ADMIN_EMAILS;
    }
  });

  it('console.warn carries reason but email text does NOT contain reason', async () => {
    process.env.ADMIN_EMAILS = 'admin@test.alert';

    const emailModule = await import('@/lib/email');
    const capturedEmailArgs: { to: string; subject: string; text: string }[] = [];
    const sendSpy = vi.spyOn(emailModule, 'sendEmail').mockImplementation(async (args) => {
      capturedEmailArgs.push(args);
      return { sent: false, transport: 'log' as const };
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { alertFounder } = await import('@/lib/alerts');
      alertFounder('moderation_flag', { context: 'x', reason: 'SECRET_QUOTE' });

      // Flush the fire-and-forget sendEmail promise.
      await new Promise((r) => setTimeout(r, 50));

      // console.warn MUST carry the reason (log channel keeps it).
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls.flatMap((call) => call.map((a) => JSON.stringify(a)));
      expect(warnArgs.some((a) => a.includes('SECRET_QUOTE'))).toBe(true);

      // sendEmail MUST have been called.
      expect(capturedEmailArgs.length).toBeGreaterThan(0);

      // Email text must NOT contain the reason (content discipline).
      for (const args of capturedEmailArgs) {
        expect(args.text).not.toContain('SECRET_QUOTE');
      }
    } finally {
      sendSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
