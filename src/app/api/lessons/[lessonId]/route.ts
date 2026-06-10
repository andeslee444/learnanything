import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { sweepStaleLessons } from '@/server/lessons/pipeline';

/**
 * Strip `correctIndex` and `explanation` from a quiz item object (in place on a deep clone).
 * These fields must not be sent to the client — answers arrive via the attempts response.
 * Done: stripped from all quiz-bearing structures (opener/quiz/worked_example.completionItem/winCheck).
 */
function stripAnswerKey(item: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { correctIndex: _ci, explanation: _ex, ...rest } = item;
  return rest;
}

/**
 * Deep-clone the lesson content and remove all answer key fields:
 * correctIndex + explanation from openerItems, quiz block items,
 * worked_example.completionItem, and winCheck.items.
 */
export function stripContentAnswerKey(content: unknown): unknown {
  if (!content || typeof content !== 'object') return content;
  const raw = content as Record<string, unknown>;
  const result: Record<string, unknown> = { ...raw };

  // openerItems
  if (Array.isArray(raw.openerItems)) {
    result.openerItems = (raw.openerItems as Record<string, unknown>[]).map(stripAnswerKey);
  }

  // blocks — walk quiz and worked_example blocks
  if (Array.isArray(raw.blocks)) {
    result.blocks = (raw.blocks as Record<string, unknown>[]).map((block) => {
      if (block.type === 'quiz' && Array.isArray(block.items)) {
        return {
          ...block,
          items: (block.items as Record<string, unknown>[]).map(stripAnswerKey),
        };
      }
      if (block.type === 'worked_example' && block.completionItem && typeof block.completionItem === 'object') {
        return {
          ...block,
          completionItem: stripAnswerKey(block.completionItem as Record<string, unknown>),
        };
      }
      return block;
    });
  }

  // winCheck.items
  if (raw.winCheck && typeof raw.winCheck === 'object') {
    const wc = raw.winCheck as Record<string, unknown>;
    if (Array.isArray(wc.items)) {
      result.winCheck = {
        ...wc,
        items: (wc.items as Record<string, unknown>[]).map(stripAnswerKey),
      };
    }
  }

  return result;
}

export async function GET(_req: Request, ctx: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await ctx.params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });

  // Ownership: lesson → track → learner
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, lesson.trackId));
  if (!track || track.learnerId !== learner.id) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Fire-and-forget sweeper: reclaims stale 'generating' lessons for this track.
  sweepStaleLessons(db, lesson.trackId).catch((err) => console.error('sweepStaleLessons error', err));

  // Strip correctIndex + explanation from all quiz-bearing structures before sending.
  // Clients highlight via the attempts response (correct boolean + explanation) — not from GET.
  const rawContent = lesson.status === 'ready' ? lesson.content : undefined;
  const content = rawContent !== undefined ? stripContentAnswerKey(rawContent) : undefined;

  const failureReason =
    lesson.status === 'failed' && lesson.content && typeof lesson.content === 'object'
      ? (lesson.content as Record<string, unknown>).failureReason
      : undefined;

  return NextResponse.json({
    status: lesson.status,
    spec: lesson.spec,
    content,
    citations: lesson.citations,
    ...(failureReason !== undefined ? { failureReason } : {}),
  });
}
