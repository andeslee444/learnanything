/**
 * POST /api/shared/[slug]/report
 *
 * Report a public shared lesson. No auth required (public surface).
 *
 * Body: { reason: 'inaccurate' | 'inappropriate' | 'copyright' | 'other' }
 * No free text — content-free discipline.
 *
 * Effects:
 *  1. Increment shared_lessons.report_count
 *  2. alertFounder('report', { slug, reason }) — content-free payload
 *  3. When new count >= 3 and current status = 'approved' → set status 'pending'
 *     (auto-unpublish pending review; cheap brigade-resistant threshold)
 *
 * Rate-limit: in-process map, 3 reports per hour per IP.
 *   IP = first value of x-forwarded-for, fallback 'unknown'.
 *
 * Status codes:
 *  200 — report recorded
 *  400 — invalid/missing reason
 *  404 — slug not found
 *  429 — rate-limited
 */

import { eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { alertFounder } from '@/lib/alerts';

// ── Reason enum ───────────────────────────────────────────────────────────────

export const REPORT_REASONS = ['inaccurate', 'inappropriate', 'copyright', 'other'] as const;
export type ReportReason = typeof REPORT_REASONS[number];

export const reportBodySchema = z.object({
  reason: z.enum(REPORT_REASONS),
});

// ── In-process rate limiter ───────────────────────────────────────────────────
//
// Founder scale: a simple in-memory map is sufficient (single instance).
// Key = IP, value = list of timestamps (within the last hour).
//
// Max 3 reports per IP per 60-minute rolling window.

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 3;

/** Exported for testing — allows tests to clear rate-limit state between cases. */
export const _reportRateMap = new Map<string, number[]>();

/** Exported for testing — clears the rate-limit map. */
export function _clearReportRateMap(): void {
  _reportRateMap.clear();
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const window = RATE_LIMIT_WINDOW_MS;
  const times = (_reportRateMap.get(ip) ?? []).filter((t) => now - t < window);
  if (times.length >= RATE_LIMIT_MAX) {
    _reportRateMap.set(ip, times);
    return true;
  }
  times.push(now);
  _reportRateMap.set(ip, times);
  return false;
}

// ── Route factory ─────────────────────────────────────────────────────────────
//
// Factory pattern (same as share route) for testability — injects the DB.
// The module's exported POST delegates to the factory with the real db.

export function createReportHandler(dbInstance: typeof db) {
  return async function POST(
    req: Request,
    ctx: { params: Promise<{ slug: string }> },
  ): Promise<NextResponse> {
    const { slug } = await ctx.params;

    // ── IP extraction for rate-limiting ──────────────────────────────────────
    const forwarded = req.headers.get('x-forwarded-for');
    const ip = forwarded ? forwarded.split(',')[0].trim() : 'unknown';

    // ── Rate-limit check ─────────────────────────────────────────────────────
    if (isRateLimited(ip)) {
      return NextResponse.json({ error: 'too_many_reports' }, { status: 429 });
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    let body: { reason: ReportReason };
    try {
      const raw = await req.json();
      body = reportBodySchema.parse(raw);
    } catch {
      // Roll back the rate-limit increment on parse error so legitimate retries
      // with correct payload are not penalised.
      const times = _reportRateMap.get(ip) ?? [];
      const last = times.lastIndexOf(times[times.length - 1]);
      if (last !== -1) times.splice(last, 1);
      if (times.length === 0) _reportRateMap.delete(ip);
      else _reportRateMap.set(ip, times);
      return NextResponse.json({ error: 'invalid_reason' }, { status: 400 });
    }

    // ── Slug lookup ───────────────────────────────────────────────────────────
    const [row] = await dbInstance
      .select({
        id: s.sharedLessons.id,
        moderationStatus: s.sharedLessons.moderationStatus,
        reportCount: s.sharedLessons.reportCount,
      })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.slug, slug));

    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // ── Increment report_count ────────────────────────────────────────────────
    // Use SQL increment so concurrent reports don't collide on a stale read.
    const AUTO_PENDING_THRESHOLD = 3;

    const newCountResult = await dbInstance
      .update(s.sharedLessons)
      .set({ reportCount: sql`${s.sharedLessons.reportCount} + 1` })
      .where(eq(s.sharedLessons.id, row.id))
      .returning({ reportCount: s.sharedLessons.reportCount });

    const newCount = newCountResult[0]?.reportCount ?? row.reportCount + 1;

    // ── Auto-unpublish at threshold ────────────────────────────────────────────
    // Only flip 'approved' → 'pending'; don't touch 'removed'/'pending' rows.
    // Comment: cheap brigade-resistant threshold.
    if (newCount >= AUTO_PENDING_THRESHOLD && row.moderationStatus === 'approved') {
      await dbInstance
        .update(s.sharedLessons)
        .set({ moderationStatus: 'pending' })
        .where(eq(s.sharedLessons.id, row.id));
    }

    // ── Alert founder — content-free payload ─────────────────────────────────
    alertFounder('report', { slug, reason: body.reason });

    return NextResponse.json({ ok: true });
  };
}

// ── Real route handler (delegates to factory with real db) ────────────────────

const _handler = createReportHandler(db);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  return _handler(req, ctx);
}
