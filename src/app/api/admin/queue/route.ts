/**
 * Admin queue API — GET returns the founder review queue, POST handles retry/dismiss.
 *
 * Gate: ADMIN_EMAILS env (comma-separated); session email must be in it → else 404.
 * Non-admin callers receive 404 (don't reveal the route exists).
 *
 * Factory: createAdminQueueHandlers(db) returns { GET, POST } for testability.
 * The module-level GET/POST thin-wrap the app db (same pattern as report/share/account routes).
 */
import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { failLessonSafely } from '@/server/lessons/pipeline';
import { generateLessonWorkflow } from '@/workflows/generate-lesson';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// ── Admin gate ────────────────────────────────────────────────────────────────

function getAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? '';
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Exported for tests — do not call at runtime outside of tests. */
export { getAdminEmails as getAdminEmailsForTest };

async function requireAdmin(): Promise<NextResponse | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const adminEmails = getAdminEmails();
  if (!adminEmails.has(session.user.email.toLowerCase())) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return null;
}

// ── Route factory ─────────────────────────────────────────────────────────────
//
// Factory pattern for testability: injects the DB instance.
// The module-level GET/POST thin-wrap the app db.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAdminQueueHandlers(dbInstance: NodePgDatabase<any>) {
  async function GET() {
    const denied = await requireAdmin();
    if (denied) return denied;

    // Queue query: failed+safety | verificationStatus=issues | faithfulnessScore<0.8
    // Exclude already-dismissed rows. Joined to tracks + learners for display.
    const rows = await dbInstance
      .select({
        id: s.lessons.id,
        status: s.lessons.status,
        verificationStatus: s.lessons.verificationStatus,
        faithfulnessScore: s.lessons.faithfulnessScore,
        content: s.lessons.content,
        createdAt: s.lessons.createdAt,
        topic: s.tracks.topic,
        displayName: s.learners.displayName,
      })
      .from(s.lessons)
      .innerJoin(s.tracks, eq(s.lessons.trackId, s.tracks.id))
      .innerJoin(s.learners, eq(s.tracks.learnerId, s.learners.id))
      .where(
        and(
          isNull(s.lessons.adminDismissedAt),
          or(
            and(
              eq(s.lessons.status, 'failed'),
              sql`(${s.lessons.content}->>'failureReason') LIKE '%safety%'`,
            ),
            eq(s.lessons.verificationStatus, 'issues'),
            lt(s.lessons.faithfulnessScore, 0.8),
          ),
        ),
      )
      .orderBy(desc(s.lessons.createdAt))
      .limit(50);

    // ── Shared lessons queue entries ─────────────────────────────────────────
    // Rows where report_count >= 1 OR moderationStatus = 'pending'.
    // Joined to the source lesson's track for the topic display.
    // Newest 50.
    const sharedRows = await dbInstance
      .select({
        id: s.sharedLessons.id,
        slug: s.sharedLessons.slug,
        vertical: s.sharedLessons.vertical,
        moderationStatus: s.sharedLessons.moderationStatus,
        reportCount: s.sharedLessons.reportCount,
        createdAt: s.sharedLessons.createdAt,
        topic: s.tracks.topic,
      })
      .from(s.sharedLessons)
      .innerJoin(s.lessons, eq(s.sharedLessons.lessonId, s.lessons.id))
      .innerJoin(s.tracks, eq(s.lessons.trackId, s.tracks.id))
      .where(
        or(
          gte(s.sharedLessons.reportCount, 1),
          eq(s.sharedLessons.moderationStatus, 'pending'),
        ),
      )
      .orderBy(desc(s.sharedLessons.createdAt))
      .limit(50);

    return NextResponse.json({ items: rows, sharedItems: sharedRows });
  }

  async function POST(req: Request) {
    const denied = await requireAdmin();
    if (denied) return denied;

    let body: { lessonId?: string; sharedLessonId?: string; action: 'retry' | 'dismiss' | 'republish' | 'take_down' };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid body' }, { status: 400 });
    }

    const { lessonId, sharedLessonId, action } = body;

    // ── Shared lesson actions ──────────────────────────────────────────────────
    if (sharedLessonId) {
      if (action !== 'republish' && action !== 'take_down') {
        return NextResponse.json({ error: 'invalid body' }, { status: 400 });
      }

      if (action === 'republish') {
        // Restore to 'approved' and reset report_count.
        await dbInstance
          .update(s.sharedLessons)
          .set({ moderationStatus: 'approved', reportCount: 0 })
          .where(eq(s.sharedLessons.id, sharedLessonId));
        return NextResponse.json({ ok: true });
      }

      // action === 'take_down'
      await dbInstance
        .update(s.sharedLessons)
        .set({ moderationStatus: 'removed' })
        .where(eq(s.sharedLessons.id, sharedLessonId));
      return NextResponse.json({ ok: true });
    }

    // ── Lesson actions (existing retry / dismiss) ────────────────────────────
    if (!lessonId || (action !== 'retry' && action !== 'dismiss')) {
      return NextResponse.json({ error: 'invalid body' }, { status: 400 });
    }

    if (action === 'dismiss') {
      await dbInstance
        .update(s.lessons)
        .set({ adminDismissedAt: new Date() })
        .where(eq(s.lessons.id, lessonId));
      return NextResponse.json({ ok: true });
    }

    // action === 'retry':
    // Admin retry is house-paid — NO placeHold/charge cycle.
    // CAS flip: failed → generating (same logic as the user retry route).
    // We do NOT call placeHold, so there is no new hold to capture.
    // The deliver path (pipeline.ts) calls findHoldId, which may find the old refunded hold
    // from the original attempt. captureHold on a refunded/already-settled hold will throw
    // "already settled" — that throw is caught by the .catch() in deliver, so it is safe.
    // Net effect: admin retries are house-paid; no new credit is consumed.
    const flipped = await dbInstance
      .update(s.lessons)
      .set({ status: 'generating', content: null })
      .where(and(eq(s.lessons.id, lessonId), eq(s.lessons.status, 'failed')))
      .returning({ id: s.lessons.id });

    if (flipped.length === 0) {
      return NextResponse.json({ error: 'lesson_not_failed' }, { status: 409 });
    }

    // Clear stale verification rows: the retry regenerates content, and old rows
    // (seeded ON CONFLICT DO NOTHING + frozen by the 'regenerated' monotonicity
    // guard) would otherwise aggregate into the new lesson's finalize forever —
    // orphan 'unverified' rows could pin the lesson at 'issues' and block the
    // re-share heal path.
    await dbInstance.delete(s.verificationResults).where(eq(s.verificationResults.lessonId, lessonId));

    // Start the workflow WITHOUT placeHold (house-paid; no hold → capture cycle).
    start(generateLessonWorkflow, [lessonId]).then(async (run) => {
      try {
        await dbInstance
          .update(s.lessons)
          .set({
            workflowRunId: run.runId,
            zpdSnapshot: sql`zpd_snapshot || ${JSON.stringify({ workflowRunId: run.runId })}::jsonb`,
          })
          .where(eq(s.lessons.id, lessonId));
      } catch (err) {
        console.error('failed to persist workflowRunId on admin retry', err);
      }
    }).catch(async (err) => {
      console.error('admin retry workflow start failed', err);
      await failLessonSafely(dbInstance as typeof db, lessonId, 'generation error — try again');
    });

    return NextResponse.json({ lessonId });
  }

  return { GET, POST };
}

// ── Real route handlers (delegate to factory with real db) ────────────────────

const _handlers = createAdminQueueHandlers(db);

export const GET = _handlers.GET;
export const POST = _handlers.POST;
