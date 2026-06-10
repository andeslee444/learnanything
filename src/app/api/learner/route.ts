import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { createLearner } from '@/server/learners';

const bodySchema = z.object({
  displayName: z.string().min(1).max(80),
  ageBand: z.enum(['13_15', '16_17', '18_plus']),
});

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const learner = await createLearner(db, { userId: session.user.id, ...parsed.data });
  return NextResponse.json({ learnerId: learner.id });
}
