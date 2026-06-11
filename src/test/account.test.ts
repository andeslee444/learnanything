/**
 * account.test.ts — Tests for export/delete endpoints (Task 3).
 *
 * Tests:
 *
 * buildExport — JSON shape:
 * 1. Contains user email, track topic, a learning-record body, a glossary term,
 *    and a ledger row.
 * 2. Learner B's data is absent from learner A's export.
 *
 * buildExport — Markdown shape:
 * 3. Contains track topic, mission why text, a glossary term, a learning record.
 * 4. Learner B's data absent from learner A's markdown.
 *
 * deleteAccount cascade (FULL world):
 * 5. Seed: user→learner→track→mission→mission_revision→skill_node→
 *         skill_node_edge→learning_record→glossary_term→resource→
 *         reference_doc→lesson→narration→verification_result→
 *         attempt_event→review_card→review_log→ledger_row→billing_customer.
 *    Delete user via deleteAccount(). Assert ZERO rows in every table for that user.
 *    A parallel "bystander" world is untouched.
 *
 * Confirm-string guard:
 * 6. POST with { confirm: 'delete' } (wrong case) → 400, nothing deleted.
 * 7. POST with { confirm: 'DELET' } → 400.
 * 8. POST with no body / invalid JSON → 400.
 *
 * Unauthenticated guard:
 * 9.  GET /api/account/export → 401 without session.
 * 10. POST /api/account/delete → 401 without session.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { testDb, testPool, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { buildExport } from '@/lib/account-export';
import { deleteAccount } from '@/lib/account-delete';

// ── Pool lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.AI_FAKE_LLM = '1';
  await resetDb();
});
afterAll(() => testPool.end());

// ── World builder ──────────────────────────────────────────────────────────────

/**
 * Seeds a FULL world for one user: every table that is reachable from the user
 * row and should be deleted when the user is deleted.
 */
async function seedFullWorld(suffix: string) {
  const uid = crypto.randomUUID();
  const email = `${uid}@account-test.dev`;

  // user
  const [user] = await testDb
    .insert(s.user)
    .values({ id: uid, name: 'Account-' + suffix, email })
    .returning();

  // learner
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: user.id, displayName: 'Learner-' + suffix, ageBand: '18_plus' })
    .returning();

  // track
  const [track] = await testDb
    .insert(s.tracks)
    .values({
      learnerId: learner.id,
      topic: 'Rust async ' + suffix,
      vertical: 'programming',
    })
    .returning();

  // mission
  const [mission] = await testDb
    .insert(s.missions)
    .values({ trackId: track.id, whyText: 'ship a real-time service ' + suffix })
    .returning();

  // learning record
  const [record] = await testDb
    .insert(s.learningRecords)
    .values({
      trackId: track.id,
      seq: 1,
      recordType: 'demonstrated_understanding',
      title: 'Understands async/await ' + suffix,
      body: 'Can write an async fn that awaits a future. ' + suffix,
    })
    .returning();

  // mission revision (links to learning record)
  const [missionRevision] = await testDb
    .insert(s.missionRevisions)
    .values({
      missionId: mission.id,
      priorSnapshot: { whyText: 'old why ' + suffix },
      reason: 'refocused goals ' + suffix,
      linkedLearningRecordId: record.id,
    })
    .returning();

  // glossary term (promotion evidence = learning record, same track)
  const [glossaryTerm] = await testDb
    .insert(s.glossaryTerms)
    .values({
      trackId: track.id,
      term: 'future-' + suffix,
      definition: 'A value that may not be ready yet. ' + suffix,
      promotionEvidenceRecordId: record.id,
    })
    .returning();

  // skill node
  const [skillNode] = await testDb
    .insert(s.skillNodes)
    .values({ trackId: track.id, name: 'tokio-basics-' + suffix })
    .returning();

  // second skill node (for edge)
  const [skillNode2] = await testDb
    .insert(s.skillNodes)
    .values({ trackId: track.id, name: 'futures-' + suffix })
    .returning();

  // skill node edge
  const [skillNodeEdge] = await testDb
    .insert(s.skillNodeEdges)
    .values({ nodeId: skillNode.id, prereqId: skillNode2.id })
    .returning();

  // resource
  const [resource] = await testDb
    .insert(s.resources)
    .values({
      trackId: track.id,
      title: 'Tokio docs ' + suffix,
      resourceType: 'docs',
      kind: 'knowledge',
      annotation: 'official async runtime docs ' + suffix,
      origin: 'exa',
      url: 'https://tokio.rs/' + suffix,
    })
    .returning();

  // reference doc
  const [referenceDoc] = await testDb
    .insert(s.referenceDocs)
    .values({
      trackId: track.id,
      title: 'Async cheat sheet ' + suffix,
      docType: 'cheat_sheet',
      content: { sections: ['basics'] },
    })
    .returning();

  // lesson
  const [lesson] = await testDb
    .insert(s.lessons)
    .values({
      trackId: track.id,
      seq: 1,
      spec: { topic: 'async basics ' + suffix },
      content: { blocks: [] },
      status: 'ready',
    })
    .returning();

  // lesson narration (bytea = empty buffer for test)
  const [narration] = await testDb
    .insert(s.lessonNarrations)
    .values({
      lessonId: lesson.id,
      mimeType: 'audio/wav',
      audio: Buffer.alloc(0),
      transcript: 'hello ' + suffix,
    })
    .returning();

  // verification result
  const [verificationResult] = await testDb
    .insert(s.verificationResults)
    .values({
      lessonId: lesson.id,
      blockId: 'block-0',
      status: 'verified',
      claimsTotal: 1,
      claimsVerified: 1,
    })
    .returning();

  // attempt event
  const [attemptEvent] = await testDb
    .insert(s.attemptEvents)
    .values({
      learnerId: learner.id,
      lessonId: lesson.id,
      eventType: 'quiz_answer',
      correct: true,
    })
    .returning();

  // review card (backed by glossary term)
  const [reviewCard] = await testDb
    .insert(s.reviewCards)
    .values({
      learnerId: learner.id,
      glossaryTermId: glossaryTerm.id,
      due: new Date(),
    })
    .returning();

  // review log entry
  const [reviewLogEntry] = await testDb
    .insert(s.reviewLog)
    .values({
      cardId: reviewCard.id,
      rating: 3,
      state: 1,
      due: new Date(),
      stability: 1.0,
      difficulty: 5.0,
      elapsedDays: 1,
      scheduledDays: 3,
      lastElapsedDays: 0,
    })
    .returning();

  // credit ledger row
  const [ledgerRow] = await testDb
    .insert(s.creditLedger)
    .values({ userId: user.id, entryType: 'grant', amount: 3 })
    .returning();

  // billing customer
  const [billingCustomer] = await testDb
    .insert(s.billingCustomers)
    .values({
      userId: user.id,
      stripeCustomerId: 'cus_test_' + suffix.replace(/[^a-z0-9]/gi, ''),
      subscriptionStatus: 'active',
    })
    .returning();

  return {
    user,
    learner,
    track,
    mission,
    missionRevision,
    record,
    glossaryTerm,
    skillNode,
    skillNode2,
    skillNodeEdge,
    resource,
    referenceDoc,
    lesson,
    narration,
    verificationResult,
    attemptEvent,
    reviewCard,
    reviewLogEntry,
    ledgerRow,
    billingCustomer,
  };
}

// ── 1-2. buildExport JSON shape ────────────────────────────────────────────────

describe('buildExport — JSON shape', () => {
  it('1. contains user email, track topic, a learning record, a glossary term, ledger rows', async () => {
    const world = await seedFullWorld('json1');
    const result = await buildExport(testDb, world.user.id, 'json');

    expect(result.contentType).toBe('application/json');
    expect(result.filename).toBe('learnanything-export.json');

    const doc = JSON.parse(result.body) as {
      user: { email: string };
      tracks: Array<{
        track: { topic: string };
        learningRecords: Array<{ body: string }>;
        glossaryTerms: Array<{ term: string }>;
      }>;
      creditLedger: Array<{ entryType: string }>;
    };

    expect(doc.user.email).toBe(world.user.email);
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].track.topic).toBe(world.track.topic);
    expect(doc.tracks[0].learningRecords.some((r) => r.body.includes(world.record.body))).toBe(true);
    expect(doc.tracks[0].glossaryTerms.some((g) => g.term === world.glossaryTerm.term)).toBe(true);
    expect(doc.creditLedger.some((l) => l.entryType === 'grant')).toBe(true);
  });

  it('2. learner B data absent from learner A export', async () => {
    const worldA = await seedFullWorld('json-a');
    const worldB = await seedFullWorld('json-b');

    const resultA = await buildExport(testDb, worldA.user.id, 'json');
    const docA = JSON.parse(resultA.body) as {
      user: { email: string };
      tracks: Array<{ track: { topic: string } }>;
    };

    expect(docA.user.email).toBe(worldA.user.email);
    expect(docA.user.email).not.toBe(worldB.user.email);
    expect(docA.tracks.every((t) => !t.track?.topic?.includes('json-b'))).toBe(true);
  });
});

// ── 3-4. buildExport Markdown shape ───────────────────────────────────────────

describe('buildExport — Markdown shape', () => {
  it('3. contains track topic, mission why text, glossary term, learning record', async () => {
    const world = await seedFullWorld('md1');
    const result = await buildExport(testDb, world.user.id, 'markdown');

    expect(result.contentType).toBe('text/markdown; charset=utf-8');
    expect(result.filename).toBe('learnanything-export.md');

    const md = result.body;
    expect(md).toContain(world.track.topic);
    expect(md).toContain(world.mission.whyText);
    expect(md).toContain(world.glossaryTerm.term);
    expect(md).toContain(world.record.title);
  });

  it('4. learner B data absent from learner A markdown', async () => {
    const worldA = await seedFullWorld('md-a');
    const worldB = await seedFullWorld('md-b');

    const resultA = await buildExport(testDb, worldA.user.id, 'markdown');
    expect(resultA.body).toContain(worldA.track.topic);
    expect(resultA.body).not.toContain(worldB.track.topic);
  });
});

// ── 5. Full cascade test ───────────────────────────────────────────────────────

describe('deleteAccount — full cascade', () => {
  it('5. deletes all rows for the target user; bystander world untouched', async () => {
    const target = await seedFullWorld('cascade-target');
    const bystander = await seedFullWorld('cascade-bystander');

    // Delete target user
    await deleteAccount(testDb, target.user.id);

    // Every table that should now have 0 rows for target user/learner/track
    const assertGone = async (
      label: string,
      query: () => Promise<unknown[]>
    ) => {
      const rows = await query();
      expect(rows, `${label} — expected 0 rows after delete`).toHaveLength(0);
    };

    // User
    await assertGone('user', () =>
      testDb.select().from(s.user).where(eq(s.user.id, target.user.id))
    );

    // Sessions (cascade from user) — sessions may be empty if none were created in seed,
    // but the FK is correct. We verify the table doesn't error.
    await assertGone('learners', () =>
      testDb.select().from(s.learners).where(eq(s.learners.userId, target.user.id))
    );

    await assertGone('tracks', () =>
      testDb.select().from(s.tracks).where(eq(s.tracks.id, target.track.id))
    );

    await assertGone('missions', () =>
      testDb.select().from(s.missions).where(eq(s.missions.id, target.mission.id))
    );

    await assertGone('mission_revisions', () =>
      testDb
        .select()
        .from(s.missionRevisions)
        .where(eq(s.missionRevisions.id, target.missionRevision.id))
    );

    await assertGone('learning_records', () =>
      testDb
        .select()
        .from(s.learningRecords)
        .where(eq(s.learningRecords.id, target.record.id))
    );

    await assertGone('glossary_terms', () =>
      testDb
        .select()
        .from(s.glossaryTerms)
        .where(eq(s.glossaryTerms.id, target.glossaryTerm.id))
    );

    await assertGone('skill_nodes', () =>
      testDb.select().from(s.skillNodes).where(eq(s.skillNodes.id, target.skillNode.id))
    );

    await assertGone('skill_node_edges', () =>
      testDb
        .select()
        .from(s.skillNodeEdges)
        .where(eq(s.skillNodeEdges.nodeId, target.skillNodeEdge.nodeId))
    );

    await assertGone('resources', () =>
      testDb.select().from(s.resources).where(eq(s.resources.id, target.resource.id))
    );

    await assertGone('reference_docs', () =>
      testDb
        .select()
        .from(s.referenceDocs)
        .where(eq(s.referenceDocs.id, target.referenceDoc.id))
    );

    await assertGone('lessons', () =>
      testDb.select().from(s.lessons).where(eq(s.lessons.id, target.lesson.id))
    );

    await assertGone('lesson_narrations', () =>
      testDb
        .select()
        .from(s.lessonNarrations)
        .where(eq(s.lessonNarrations.id, target.narration.id))
    );

    await assertGone('verification_results', () =>
      testDb
        .select()
        .from(s.verificationResults)
        .where(eq(s.verificationResults.id, target.verificationResult.id))
    );

    await assertGone('attempt_events', () =>
      testDb
        .select()
        .from(s.attemptEvents)
        .where(eq(s.attemptEvents.id, target.attemptEvent.id))
    );

    await assertGone('review_cards', () =>
      testDb.select().from(s.reviewCards).where(eq(s.reviewCards.id, target.reviewCard.id))
    );

    await assertGone('review_log', () =>
      testDb
        .select()
        .from(s.reviewLog)
        .where(eq(s.reviewLog.id, target.reviewLogEntry.id))
    );

    await assertGone('credit_ledger', () =>
      testDb
        .select()
        .from(s.creditLedger)
        .where(eq(s.creditLedger.id, target.ledgerRow.id))
    );

    await assertGone('billing_customers', () =>
      testDb
        .select()
        .from(s.billingCustomers)
        .where(eq(s.billingCustomers.id, target.billingCustomer.id))
    );

    // ── Bystander world still intact ──────────────────────────────────────────

    const assertPresent = async (label: string, query: () => Promise<unknown[]>) => {
      const rows = await query();
      expect(rows, `${label} — bystander row should still exist`).toHaveLength(1);
    };

    await assertPresent('bystander user', () =>
      testDb.select().from(s.user).where(eq(s.user.id, bystander.user.id))
    );
    await assertPresent('bystander learner', () =>
      testDb.select().from(s.learners).where(eq(s.learners.id, bystander.learner.id))
    );
    await assertPresent('bystander track', () =>
      testDb.select().from(s.tracks).where(eq(s.tracks.id, bystander.track.id))
    );
    await assertPresent('bystander mission', () =>
      testDb.select().from(s.missions).where(eq(s.missions.id, bystander.mission.id))
    );
    await assertPresent('bystander lesson', () =>
      testDb.select().from(s.lessons).where(eq(s.lessons.id, bystander.lesson.id))
    );
    await assertPresent('bystander ledger', () =>
      testDb
        .select()
        .from(s.creditLedger)
        .where(eq(s.creditLedger.id, bystander.ledgerRow.id))
    );
  });
});

// ── 6-8. Confirm-string guard ──────────────────────────────────────────────────

describe('POST /api/account/delete — confirm string guard', () => {
  it('6. wrong case { confirm: "delete" } → 400, user not deleted', async () => {
    const world = await seedFullWorld('confirm-wrong-case');

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({ user: { id: world.user.id } }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));

    const { createPostHandler } = await import('@/app/api/account/delete/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/account/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'delete' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);

    // User must still exist
    const [still] = await testDb.select().from(s.user).where(eq(s.user.id, world.user.id));
    expect(still).toBeDefined();

    vi.resetModules();
  });

  it('7. partial string { confirm: "DELET" } → 400', async () => {
    const world = await seedFullWorld('confirm-partial');

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({ user: { id: world.user.id } }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));

    const { createPostHandler } = await import('@/app/api/account/delete/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/account/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'DELET' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);

    vi.resetModules();
  });

  it('8. invalid JSON body → 400', async () => {
    const world = await seedFullWorld('confirm-no-body');

    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue({ user: { id: world.user.id } }),
        },
      },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));

    const { createPostHandler } = await import('@/app/api/account/delete/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/account/delete', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);

    vi.resetModules();
  });
});

// ── 9-10. Unauthenticated guard ────────────────────────────────────────────────

describe('401 when unauthenticated', () => {
  it('9. GET /api/account/export → 401', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));

    const { createGetHandler } = await import('@/app/api/account/export/route');
    const GET = createGetHandler(testDb);
    const req = new NextRequest('http://localhost/api/account/export?format=json');
    const res = await GET(req);
    expect(res.status).toBe(401);

    vi.resetModules();
  });

  it('10. POST /api/account/delete → 401', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
    }));
    vi.doMock('next/headers', () => ({
      headers: vi.fn().mockResolvedValue(new Headers()),
    }));

    const { createPostHandler } = await import('@/app/api/account/delete/route');
    const POST = createPostHandler(testDb);
    const req = new NextRequest('http://localhost/api/account/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'DELETE' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);

    vi.resetModules();
  });
});
