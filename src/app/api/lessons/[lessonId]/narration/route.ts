/**
 * GET  /api/lessons/[lessonId]/narration          → audio bytes (Cache-Control private 1d)
 * GET  /api/lessons/[lessonId]/narration?transcript=1 → JSON { transcript }
 * POST /api/lessons/[lessonId]/narration          → generate (idempotent) → 200 { ok: true }
 *
 * Auth: session → learner → ownership (lesson → track → learner).
 * POST debounce: 5 s per user (same pattern as tutor route).
 * POST requires lesson.status === 'ready'.
 * POST is idempotent: existing row → 200 cached immediately.
 */

import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { buildNarrationScript, synthesizeNarration } from '@/server/lessons/narration';
import type { LessonContent } from '@/server/lessons/blocks';

// ── Per-user POST debounce (5s — established pattern, same as tutor route) ──
const lastNarrationByUser = new Map<string, number>();
const DEBOUNCE_MS = 5_000;

type Ctx = { params: Promise<{ lessonId: string }> };

// ── Ownership helper (DRY between GET and POST) ──────────────────────────────

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

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: Request, ctx: Ctx) {
  const { lessonId } = await ctx.params;

  const ownership = await resolveOwnership(lessonId);
  if ('error' in ownership) {
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
  }

  // Fetch cached narration row
  const [narration] = await db
    .select()
    .from(s.lessonNarrations)
    .where(eq(s.lessonNarrations.lessonId, lessonId));

  if (!narration) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // ?transcript=1 → JSON response
  const url = new URL(req.url);
  if (url.searchParams.get('transcript') === '1') {
    return NextResponse.json({ transcript: narration.transcript });
  }

  // Serve audio bytes — cast to Uint8Array so TS accepts it as BodyInit
  return new Response(new Uint8Array(narration.audio), {
    status: 200,
    headers: {
      'Content-Type': narration.mimeType,
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(_req: Request, ctx: Ctx) {
  const { lessonId } = await ctx.params;

  const ownership = await resolveOwnership(lessonId);
  if ('error' in ownership) {
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
  }
  const { learner, lesson } = ownership;

  // Must be ready
  if (lesson.status !== 'ready') {
    return NextResponse.json({ error: 'lesson_not_ready' }, { status: 409 });
  }

  // Idempotency: if narration already exists, return cached
  const [existing] = await db
    .select({ id: s.lessonNarrations.id })
    .from(s.lessonNarrations)
    .where(eq(s.lessonNarrations.lessonId, lessonId));
  if (existing) {
    return NextResponse.json({ ok: true, cached: true });
  }

  // Per-user debounce (after ownership + idempotency checks so 404s/cached aren't rate-limited)
  const last = lastNarrationByUser.get(learner.id) ?? 0;
  if (Date.now() - last < DEBOUNCE_MS) {
    return NextResponse.json({ error: 'too_fast' }, { status: 429 });
  }
  lastNarrationByUser.set(learner.id, Date.now());

  // Build narration script
  const content = lesson.content as (Omit<LessonContent, 'openerItems'> & { openerItems?: unknown }) | null;
  if (!content) {
    return NextResponse.json({ error: 'lesson content missing' }, { status: 422 });
  }
  const objective = (lesson.spec as { objective?: string })?.objective ?? '';
  const script = buildNarrationScript(content, objective);

  // Synthesize audio
  let audioResult: { buffer: Buffer; mimeType: string };
  try {
    audioResult = await synthesizeNarration(script);
  } catch (err) {
    console.error('TTS synthesis error', err);
    return NextResponse.json({ error: 'tts_unavailable' }, { status: 503 });
  }

  // Insert — ON CONFLICT DO NOTHING handles concurrent duplicate POSTs
  await db
    .insert(s.lessonNarrations)
    .values({
      lessonId,
      mimeType: audioResult.mimeType,
      audio: audioResult.buffer,
      transcript: script,
    })
    .onConflictDoNothing({ target: s.lessonNarrations.lessonId });

  return NextResponse.json({ ok: true, cached: false });
}
