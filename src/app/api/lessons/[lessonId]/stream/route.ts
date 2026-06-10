import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { getRun } from 'workflow/api';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';

type Db = NodePgDatabase<typeof s>;

// Terminal lesson statuses — if the lesson is in one of these states the
// workflow stream is already closed; the client should do a single GET instead.
const TERMINAL_LESSON_STATUSES = new Set(['ready', 'failed']);

/**
 * Exported helper for unit-testable ownership/guard checks (no HTTP layer).
 * Returns the runId string or an error object that mirrors the HTTP status.
 * Accepts an explicit db so tests can pass testDb.
 */
export async function resolveStreamRunId(
  dbArg: Db,
  lessonId: string,
  learnerId: string,
): Promise<{ ok: true; runId: string } | { ok: false; status: 404 | 409; error: string }> {
  const [lesson] = await dbArg.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson) return { ok: false, status: 404, error: 'not found' };
  const [track] = await dbArg.select().from(s.tracks).where(eq(s.tracks.id, lesson.trackId));
  if (!track || track.learnerId !== learnerId) return { ok: false, status: 404, error: 'not found' };
  if (TERMINAL_LESSON_STATUSES.has(lesson.status)) return { ok: false, status: 409, error: 'lesson_terminal' };
  const snapshot = lesson.zpdSnapshot as Record<string, unknown> | null;
  const runId = snapshot?.workflowRunId;
  if (!runId || typeof runId !== 'string') return { ok: false, status: 404, error: 'run_not_started' };
  return { ok: true, runId };
}

export async function GET(req: Request, ctx: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await ctx.params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });

  const result = await resolveStreamRunId(db, lessonId, learner.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // Parse optional ?startIndex= for reconnection.
  const url = new URL(req.url);
  const startIndexParam = url.searchParams.get('startIndex');
  const startIndex = startIndexParam !== null ? parseInt(startIndexParam, 10) : undefined;

  const run = getRun(result.runId);
  const stream = run.getReadable<import('@/workflows/generate-lesson').ProgressEvent>(
    startIndex !== undefined ? { startIndex } : undefined,
  );

  // Proxy the readable stream directly as the response body.
  // Content-Type: text/plain matches the workflow streaming doc convention for plain streams.
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
