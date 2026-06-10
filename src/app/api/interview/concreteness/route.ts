import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { llmObject } from '@/lib/ai';

const resultSchema = z.object({
  concrete: z.boolean(),
  followUp: z.string().nullable(), // ONE follow-up question when not concrete (spec §1)
});

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = z.object({ topic: z.string().max(200), why: z.string().min(1).max(2000) }).safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const result = await llmObject({
    purpose: 'concreteness',
    tier: 'classifier',
    schema: resultSchema,
    system:
      'You assess whether a learner\'s reason for learning is CONCRETE (a real-world outcome: pass an exam, build something specific, a job task, teach someone) or ABSTRACT ("to understand X", "general interest"). "Just curious" counts as concrete — curiosity is a valid mission. If abstract, write ONE warm follow-up question asking what they would do with the skill. Never more than one question.',
    prompt: `Topic: ${body.data.topic}\nLearner's why: ${body.data.why}`,
  });
  return NextResponse.json(result);
}
