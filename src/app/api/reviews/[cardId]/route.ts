import { eq, and } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { assembleReviewItem, gradeReview } from '@/lib/reviews';
import type { DueCardRow } from '@/lib/reviews';

const bodySchema = z.object({
  optionText: z.string().min(1).max(500),
});

/**
 * POST /api/reviews/[cardId]
 *
 * Grades a review answer.
 * - Ownership ladder: session → learner → card.learnerId match.
 * - Recomputes the item server-side (same deterministic assembleReviewItem call)
 *   to find the correctIndex — no correctIndex travels to the client.
 * - Returns { correct, correctOption, explanation, nextDueInDays }.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ cardId: string }> },
) {
  const { cardId } = await ctx.params;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const { optionText } = parsed.data;

  // Load the card with its glossary term (ownership + full card data).
  const rows = await db
    .select({
      id: s.reviewCards.id,
      learnerId: s.reviewCards.learnerId,
      glossaryTermId: s.reviewCards.glossaryTermId,
      due: s.reviewCards.due,
      stability: s.reviewCards.stability,
      difficulty: s.reviewCards.difficulty,
      elapsedDays: s.reviewCards.elapsedDays,
      scheduledDays: s.reviewCards.scheduledDays,
      learningSteps: s.reviewCards.learningSteps,
      reps: s.reviewCards.reps,
      lapses: s.reviewCards.lapses,
      state: s.reviewCards.state,
      lastReview: s.reviewCards.lastReview,
      term: s.glossaryTerms.term,
      definition: s.glossaryTerms.definition,
      trackId: s.glossaryTerms.trackId,
    })
    .from(s.reviewCards)
    .innerJoin(s.glossaryTerms, eq(s.reviewCards.glossaryTermId, s.glossaryTerms.id))
    .where(
      and(
        eq(s.reviewCards.id, cardId),
        eq(s.reviewCards.learnerId, learner.id),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const card = rows[0] as DueCardRow;

  // Grade by comparing the submitted option text against the card's own definition.
  // This is drift-proof: the distractor set can change between assemble and grade
  // without affecting correctness — we never rely on a position index.
  const correct = optionText.trim() === card.definition.trim();

  // Build the item server-side solely to obtain correctOption for the response.
  // answerIndex leaves the grading path entirely; correctIndex is only used here.
  const item = await assembleReviewItem(db, card);
  const correctOption = item.options[item.correctIndex];
  const explanation = card.definition;

  // Grade the review — updates card state, inserts review_log + attempt_event
  const now = new Date();
  const gradeResult = await gradeReview(db, {
    cardId,
    learnerId: learner.id,
    correct,
    now,
  });

  // nextDueInDays: days from now to next due date (0 for learning/relearning steps still today)
  const msPerDay = 1000 * 60 * 60 * 24;
  const nextDueInDays = Math.max(
    0,
    Math.round((gradeResult.nextDue.getTime() - now.getTime()) / msPerDay),
  );

  return NextResponse.json({
    correct,
    correctOption,
    explanation,
    nextDueInDays,
  });
}
