/**
 * POST /api/lessons/[lessonId]/share  → share lesson
 * DELETE /api/lessons/[lessonId]/share → unshare lesson
 *
 * Auth: session → learner → ownership (lesson → track → learner).
 * POST requires lesson.status === 'ready'.
 * POST is idempotent: existing shared row → 200 {slug, url}.
 * POST SanitizeError (retryable) → 503 {error:'sanitize_unavailable', retryable:true}.
 * POST SanitizeError (non-retryable) → 422 {error:'cannot_share'}.
 *   Comment: fail closed, never publish on a failed gate (spec §7).
 * POST debounce (5s per user) → 429 {error:'too_fast'} (only for new shares).
 * DELETE is idempotent: no row → 200 (public URL 404s after).
 * DELETE admin-removed row → 403 {error:'removed_by_moderation'}.
 *
 * Exports:
 *   createShareRouteHandlers(db) — factory for test injection.
 *   POST, DELETE                 — production handlers (thin-wrap app db).
 */

import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { createShareHandlers } from '@/server/lessons/share';

type Db = NodePgDatabase<typeof s>;
type Ctx = { params: Promise<{ lessonId: string }> };

// ── Ownership helper (shared between POST and DELETE) ─────────────────────────

async function resolveOwnership(database: Db, lessonId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: 'unauthenticated', status: 401 } as const;

  const learner = await getLearnerByUserId(database, session.user.id);
  if (!learner) return { error: 'no learner profile', status: 403 } as const;

  const [lesson] = await database.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson) return { error: 'not found', status: 404 } as const;

  const [track] = await database.select().from(s.tracks).where(eq(s.tracks.id, lesson.trackId));
  if (!track || track.learnerId !== learner.id) return { error: 'not found', status: 404 } as const;

  return { learner, lesson, track } as const;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createShareRouteHandlers(database: Db) {
  async function POST(_req: NextRequest, ctx: Ctx) {
    const { lessonId } = await ctx.params;

    const ownership = await resolveOwnership(database, lessonId);
    if ('error' in ownership) {
      return NextResponse.json({ error: ownership.error }, { status: ownership.status });
    }
    const { lesson, track } = ownership;

    // Must be ready
    if (lesson.status !== 'ready') {
      return NextResponse.json({ error: 'lesson_not_ready' }, { status: 409 });
    }

    const { shareLesson } = createShareHandlers(database);
    const result = await shareLesson(lesson, track);

    if ('kind' in result) {
      if (result.kind === 'sanitize_unavailable') {
        return NextResponse.json(
          { error: 'sanitize_unavailable', retryable: true },
          { status: 503 },
        );
      }
      if (result.kind === 'too_fast') {
        return NextResponse.json({ error: 'too_fast' }, { status: 429 });
      }
      // cannot_share — fail closed
      return NextResponse.json({ error: 'cannot_share' }, { status: 422 });
    }

    return NextResponse.json({ slug: result.slug, url: result.url, vertical: result.vertical });
  }

  async function DELETE(_req: NextRequest, ctx: Ctx) {
    const { lessonId } = await ctx.params;

    const ownership = await resolveOwnership(database, lessonId);
    if ('error' in ownership) {
      return NextResponse.json({ error: ownership.error }, { status: ownership.status });
    }

    const { unshareLesson } = createShareHandlers(database);
    const result = await unshareLesson(lessonId);

    if (result && 'kind' in result && result.kind === 'removed_by_moderation') {
      return NextResponse.json({ error: 'removed_by_moderation' }, { status: 403 });
    }

    return NextResponse.json({ ok: true });
  }

  return { POST, DELETE };
}

// ── Production module-level exports ──────────────────────────────────────────

const _handlers = createShareRouteHandlers(db);
export const POST = _handlers.POST;
export const DELETE = _handlers.DELETE;
