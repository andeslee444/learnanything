/**
 * POST /api/shared/[slug]/report
 *
 * Report a public shared lesson. No auth required (public surface).
 *
 * Body: { reason: 'inaccurate' | 'inappropriate' | 'copyright' | 'other' }
 * No free text — content-free discipline.
 *
 * Effects (only when an APPROVED row exists):
 *  1. Increment shared_lessons.report_count
 *  2. alertFounder('report', { slug, reason }) — content-free payload
 *
 * NOTE: auto-unpublish was weaponizable (spoofable reporter identity);
 * reports are alert+queue signals only — the FOUNDER decides takedowns.
 * (decision 2026-06-11)
 *
 * Rate-limit: in-process map, 3 reports per hour per IP.
 *   IP = LAST entry of x-forwarded-for (platform-appended on Vercel, trustworthy).
 *   Using the LAST (not first) because the client controls earlier entries;
 *   the platform appends its own observed IP at the end.
 *
 * Uniform response policy:
 *   400 — invalid/missing reason (leaks nothing slug-specific)
 *   429 — rate-limited (leaks nothing slug-specific)
 *   200 — everything else:
 *     - approved row → increment + alert
 *     - hidden/pending/removed row → no side effects, same 200
 *     - absent slug → no side effects, same 200
 *   "uniform response — the report endpoint must not be a slug-existence oracle
 *    (the public page 404s uniformly too)" (decision 2026-06-11)
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
    // Use the LAST entry of x-forwarded-for: on Vercel (and most CDNs) the
    // platform appends its own observed IP at the tail, making it trustworthy.
    // The client controls all earlier entries — using [0] would let an attacker
    // spoof any IP by setting the header themselves.
    const forwarded = req.headers.get('x-forwarded-for');
    const ip = forwarded
      ? forwarded.split(',').map((s) => s.trim()).filter(Boolean).pop() ?? 'unknown'
      : 'unknown';

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
    // uniform response — the report endpoint must not be a slug-existence oracle
    // (the public page 404s uniformly too). Only act when an APPROVED row exists.
    const [row] = await dbInstance
      .select({
        id: s.sharedLessons.id,
        moderationStatus: s.sharedLessons.moderationStatus,
      })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.slug, slug));

    // Non-existent, pending, or removed rows: no side effects, same 200.
    if (!row || row.moderationStatus !== 'approved') {
      return NextResponse.json({ ok: true });
    }

    // ── Increment report_count ────────────────────────────────────────────────
    // Use SQL increment so concurrent reports don't collide on a stale read.
    // No auto-unpublish: auto-unpublish was weaponizable (spoofable reporter
    // identity); reports are alert+queue signals only (decision 2026-06-11).
    await dbInstance
      .update(s.sharedLessons)
      .set({ reportCount: sql`${s.sharedLessons.reportCount} + 1` })
      .where(eq(s.sharedLessons.id, row.id));

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
