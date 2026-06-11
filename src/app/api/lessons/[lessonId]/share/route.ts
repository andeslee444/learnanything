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
 * DELETE is idempotent: no row → 200 (public URL 404s after).
 */

import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { createShareHandlers } from '@/server/lessons/share';

type Ctx = { params: Promise<{ lessonId: string }> };

// ── Ownership helper (shared between POST and DELETE) ─────────────────────────

async function resolveOwnership(lessonId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: 'unauthenticated', status: 401 } as const;

  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return { error: 'no learner profile', status: 403 } as const;

  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson) return { error: 'not found', status: 404 } as const;

  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, lesson.trackId));
  if (!track || track.learnerId !== learner.id) return { error: 'not found', status: 404 } as const;

  return { learner, lesson, track } as const;
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(_req: Request, ctx: Ctx) {
  const { lessonId } = await ctx.params;

  const ownership = await resolveOwnership(lessonId);
  if ('error' in ownership) {
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
  }
  const { lesson, track } = ownership;

  // Must be ready
  if (lesson.status !== 'ready') {
    return NextResponse.json({ error: 'lesson_not_ready' }, { status: 409 });
  }

  const { shareLesson } = createShareHandlers(db);
  const result = await shareLesson(lesson, track);

  if ('kind' in result) {
    if (result.kind === 'sanitize_unavailable') {
      return NextResponse.json(
        { error: 'sanitize_unavailable', retryable: true },
        { status: 503 },
      );
    }
    // cannot_share — fail closed
    return NextResponse.json({ error: 'cannot_share' }, { status: 422 });
  }

  return NextResponse.json({ slug: result.slug, url: result.url, vertical: result.vertical });
}

// ── DELETE ────────────────────────────────────────────────────────────────────

export async function DELETE(_req: Request, ctx: Ctx) {
  const { lessonId } = await ctx.params;

  const ownership = await resolveOwnership(lessonId);
  if ('error' in ownership) {
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
  }

  const { unshareLesson } = createShareHandlers(db);
  await unshareLesson(lessonId);

  return NextResponse.json({ ok: true });
}
