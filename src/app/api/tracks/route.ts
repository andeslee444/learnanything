import { count, eq, ne, and } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { moderateText } from '@/server/moderation';
import { createTrackInput, createTrackWithMission } from '@/server/tracks';

const TRACK_CAP = 10;

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });

  // Fix 7: guard malformed request body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = createTrackInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', details: parsed.error.flatten() }, { status: 400 });
  }

  const moderation = await moderateText(`${parsed.data.topic}\n${parsed.data.whyText}`, 'learning_request');
  if (!moderation.allowed) {
    const status = moderation.errored ? 503 : 422;
    return NextResponse.json({ error: 'moderation', retryable: !!moderation.errored }, { status });
  }

  // Fix 6: track cap — count the learner's non-archived tracks.
  const [{ value: nonArchivedCount }] = await db
    .select({ value: count() })
    .from(s.tracks)
    .where(and(eq(s.tracks.learnerId, learner.id), ne(s.tracks.status, 'archived')));

  if (nonArchivedCount >= TRACK_CAP) {
    return NextResponse.json({ error: 'track_limit' }, { status: 403 });
  }

  const track = await createTrackWithMission(db, learner.id, parsed.data);
  return NextResponse.json({ trackId: track.id });
}
