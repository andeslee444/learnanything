/**
 * GET /api/lessons/[lessonId]/verification
 *
 * Returns the per-block verification results for a lesson.
 * Shape: Array<{ blockId: string; status: string; claimsVerified: number; claimsTotal: number }>
 *
 * Sorted by blockId (block-0, block-1, …) so the client can index directly.
 *
 * If no rows exist yet (lesson pre-Phase-6 or workflow not yet started),
 * returns an empty array []. The client renders no badges in that case (backward compatible).
 */

import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ lessonId: string }> },
) {
  const { lessonId } = await ctx.params;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });

  // Ownership: lesson → track → learner
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, lesson.trackId));
  if (!track || track.learnerId !== learner.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // Fetch all verification_results rows for this lesson, ladder-style.
  const rows = await db
    .select({
      blockId: s.verificationResults.blockId,
      status: s.verificationResults.status,
      claimsVerified: s.verificationResults.claimsVerified,
      claimsTotal: s.verificationResults.claimsTotal,
    })
    .from(s.verificationResults)
    .where(eq(s.verificationResults.lessonId, lessonId));

  // Sort by blockId natural order (block-0, block-1, block-2, …).
  // The numeric sort ensures block-10 sorts after block-9, not block-1.
  rows.sort((a, b) => {
    const ai = parseInt(a.blockId.replace('block-', ''), 10);
    const bi = parseInt(b.blockId.replace('block-', ''), 10);
    return ai - bi;
  });

  return NextResponse.json(rows);
}
