/**
 * GET /api/cron/mission-report
 *
 * Cron-guarded (Vercel cron: 0 14 * * 1 — 2 PM UTC every Monday).
 * Bearer authorization: Authorization: Bearer ${CRON_SECRET}.
 *
 * For each learner+track with ≥1 lesson completed (win_check pass) in the
 * last 7 days, sends a weekly mission report email:
 *   "This week on {topic}: X lessons, Y new terms"
 *
 * "New terms" = glossary_terms rows created for that TRACK in the last 7 days.
 * glossary_terms has both `track_id` and `created_at`, so the count is
 * track-scoped and time-bounded — matching the per-track email copy exactly.
 * (review_cards.due is the FSRS next-review timestamp, not a creation date,
 * and review_cards is learner-scoped, not track-scoped — wrong on both counts.)
 *
 * Content discipline: only topic names (user-supplied at track creation),
 * lesson counts, and term counts are included — no lesson text, no card content.
 */

import { NextResponse } from 'next/server';
import { and, count, countDistinct, eq, gte, isNotNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db as appDb } from '@/lib/db';
import * as s from '@/db/schema';
import { sendEmail, sanitizeSubjectPart } from '@/lib/email';

type Db = NodePgDatabase<typeof s>;

export interface MissionReportRow {
  learnerId: string;
  trackId: string;
  topic: string;
  userEmail: string;
  lessonCount: number;
  newTermCount: number;
}

export interface MissionReportResult {
  recipients: number;
  sent: number;
}

/**
 * Core query + send loop — exported for direct test invocation.
 *
 * Finds learner+track pairs where ≥1 win_check pass attempt_event was created
 * in the last 7 days (window = [since, now]).
 *
 * "New terms" = glossary_terms rows where track_id = the reported track AND
 * created_at >= windowStart.  glossary_terms is track-scoped and has created_at,
 * so the count is correct per-track and matches the email copy exactly.
 */
export async function runMissionReport(db: Db, since?: Date): Promise<MissionReportResult> {
  const now = new Date();
  const windowStart = since ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Find learner+track pairs with win_check pass events in the window.
  // A "completed lesson" = at least one win_check attempt_event in the window.
  const lessonRows = await db
    .select({
      learnerId: s.attemptEvents.learnerId,
      trackId: s.lessons.trackId,
      topic: s.tracks.topic,
      userEmail: s.user.email,
      lessonCount: countDistinct(s.attemptEvents.lessonId),
    })
    .from(s.attemptEvents)
    .innerJoin(s.lessons, eq(s.attemptEvents.lessonId, s.lessons.id))
    .innerJoin(s.tracks, eq(s.lessons.trackId, s.tracks.id))
    .innerJoin(s.learners, eq(s.attemptEvents.learnerId, s.learners.id))
    .innerJoin(s.user, eq(s.learners.userId, s.user.id))
    .where(
      and(
        eq(s.attemptEvents.eventType, 'win_check'),
        eq(s.attemptEvents.correct, true),
        gte(s.attemptEvents.createdAt, windowStart),
        isNotNull(s.attemptEvents.lessonId),
      ),
    )
    .groupBy(
      s.attemptEvents.learnerId,
      s.lessons.trackId,
      s.tracks.topic,
      s.user.email,
    );

  // For each track, count new glossary terms created in the window.
  // glossary_terms has track_id + created_at — correct for per-track email copy.
  // Build a map: trackId → newTermCount
  const termRows = await db
    .select({
      trackId: s.glossaryTerms.trackId,
      newTermCount: count(s.glossaryTerms.id),
    })
    .from(s.glossaryTerms)
    .where(gte(s.glossaryTerms.createdAt, windowStart))
    .groupBy(s.glossaryTerms.trackId);

  const termsByTrack = new Map<string, number>();
  for (const r of termRows) {
    termsByTrack.set(r.trackId, Number(r.newTermCount));
  }

  const recipients = lessonRows.length;
  let sent = 0;

  for (const row of lessonRows) {
    const lessonCount = Number(row.lessonCount);
    if (lessonCount < 1) continue;
    // Count new glossary terms for this track in the window (track-scoped, time-bounded).
    const newTermCount = termsByTrack.get(row.trackId) ?? 0;

    const topic = sanitizeSubjectPart(row.topic);
    const result = await sendEmail({
      to: row.userEmail,
      subject: `Your LearnAnything weekly report: ${topic}`,
      // Content discipline: topic (user-supplied), counts only — no lesson text.
      text: `This week on ${topic}: ${lessonCount} lesson${lessonCount === 1 ? '' : 's'}, ${newTermCount} new term${newTermCount === 1 ? '' : 's'}.`,
    }).catch((err) => {
      // Recipient-free by design: signal a broken transport without leaking who failed.
      console.error('[cron:email-send-failed]', err instanceof Error ? err.message : String(err));
      return null;
    });
    if (result?.sent || result?.transport === 'log') sent++;
  }

  return { recipients, sent };
}

export async function GET(req: Request) {
  // Auth guard: fail closed — 401 when CRON_SECRET unset or wrong.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 401 });
  }
  const authHeader = req.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (bearer !== cronSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = await runMissionReport(appDb);
  return NextResponse.json({ ok: true, ...result });
}
