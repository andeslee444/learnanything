import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { llmObject } from '@/lib/ai';

// Process-local debounce — good enough pre-credits; replace with a DB counter at the billing phase.
const lastCallByUser = new Map<string, number>();
const DEBOUNCE_MS = 5000;

const resultSchema = z.object({
  concrete: z.boolean(),
  followUp: z.string().nullable(), // ONE follow-up question when not concrete (spec §1)
});

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = z.object({ topic: z.string().min(1).max(200), why: z.string().min(1).max(2000) }).safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const last = lastCallByUser.get(session.user.id) ?? 0;
  if (Date.now() - last < DEBOUNCE_MS) {
    return NextResponse.json({ error: 'too_fast' }, { status: 429 });
  }
  lastCallByUser.set(session.user.id, Date.now());

  let result: { concrete: boolean; followUp: string | null };
  try {
    result = await llmObject({
      purpose: 'concreteness',
      tier: 'classifier',
      schema: resultSchema,
      system:
        'You assess whether a learner\'s reason for learning is CONCRETE (a real-world outcome: pass an exam, build something specific, a job task, teach someone) or ABSTRACT ("to understand X", "general interest"). "Just curious" counts as concrete — curiosity is a valid mission. If abstract, write ONE warm follow-up question asking what they would do with the skill. Never more than one question.',
      prompt: `Topic: ${body.data.topic}\nLearner's why: ${body.data.why}`,
    });
  } catch (err) {
    console.warn('concreteness classifier unavailable, treating as concrete', err);
    result = { concrete: true, followUp: null };
  }
  return NextResponse.json(result);
}
