import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getLearnerByUserId } from '@/server/learners';
import { getTrackDetail } from '@/server/tracks';
import { initializeTrack } from '@/server/track-init';

export const maxDuration = 300; // Opus-tier graph generation can take minutes

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });
  const detail = await getTrackDetail(db, id, learner.id); // ownership check
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });

  try {
    const result = await initializeTrack(db, id);
    if (result.status === 'failed') return NextResponse.json(result, { status: 502 });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[initialize] generation error:', err);
    return NextResponse.json(
      { status: 'failed', errors: ['generation error — try again'] },
      { status: 502 }
    );
  }
}
