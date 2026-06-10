import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { getTrackDetail } from '@/server/tracks';

const bodySchema = z.object({
  item: z.object({
    id: z.string(),
    question: z.string(),
    options: z.array(z.string()).length(4),
    correctIndex: z.number().int().min(0).max(3),
    conceptName: z.string(),
  }),
  answerIndex: z.number().int().min(0).max(3),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });
  if (!(await getTrackDetail(db, id, learner.id))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const { item, answerIndex } = parsed.data;
  await db.insert(s.attemptEvents).values({
    learnerId: learner.id,
    eventType: 'calibration',
    correct: answerIndex === item.correctIndex,
    payload: { trackId: id, item, answerIndex }, // raw storage — distilled in Phase 5
  });
  return NextResponse.json({ correct: answerIndex === item.correctIndex });
}
