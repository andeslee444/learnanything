/**
 * FSRS review engine — Phase 5a core.
 *
 * All public functions accept `db` as the first argument (established DI convention).
 *
 * Rating map (v1 two-point scale — Hard/Easy unused until self-paced grading exists):
 *   correct → Rating.Good (3)
 *   incorrect → Rating.Again (1)
 */
import { and, asc, eq, lte, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import type { Card, ReviewLog } from 'ts-fsrs';
import * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;

// ── Field-name mapping (ts-fsrs ↔ review_cards columns) ─────────────────────
// ts-fsrs Card fields use snake_case; Drizzle schema uses camelCase.
// Dates: ts-fsrs uses Date objects; DB stores timestamptz (JS Date ↔ PG fine).
// ts-fsrs `elapsed_days` is deprecated in v6 but still present on the Card object.
// We store it because the DB column exists from Phase 1 and the optimizer uses it.

function cardToDbFields(card: Card) {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as number,
    lastReview: card.last_review ?? null,
  };
}

// ── Deterministic shuffle (LCG on string hash — no Math.random) ──────────────
// Same pattern as fakeEmbedding in src/server/research/embeddings.ts.

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function lcgShuffle<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0; // LCG — deterministic, no Math.random
    // Float-derived index avoids modulo bias: state is a 32-bit unsigned int in [0, 2^32).
    // Dividing by 2^32 yields a float in [0, 1) with no bias across any range ≤ 2^32.
    const f = state / 0x100000000;
    const j = Math.floor(f * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── Generic distractors (pad when fewer than 3 other glossary defs exist) ────
const GENERIC_DISTRACTORS = [
  'A temporary placeholder used during computation.',
  'A reserved keyword that controls program flow.',
  'An immutable reference to a fixed memory address.',
] as const;

// ── Public API ────────────────────────────────────────────────────────────────

/** Idempotent: creates a review card for a glossary term if one does not already exist. */
export async function createCardForGlossaryTerm(
  db: Db,
  opts: { learnerId: string; glossaryTermId: string },
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .select({ id: s.reviewCards.id })
    .from(s.reviewCards)
    .where(
      and(
        eq(s.reviewCards.learnerId, opts.learnerId),
        eq(s.reviewCards.glossaryTermId, opts.glossaryTermId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return { id: existing[0].id, created: false };
  }

  const emptyCard = createEmptyCard(new Date());
  const fields = cardToDbFields(emptyCard);

  const [inserted] = await db
    .insert(s.reviewCards)
    .values({
      learnerId: opts.learnerId,
      glossaryTermId: opts.glossaryTermId,
      ...fields,
    })
    .returning({ id: s.reviewCards.id });

  return { id: inserted.id, created: true };
}

export interface DueCardRow {
  id: string;
  learnerId: string;
  glossaryTermId: string;
  due: Date;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: Date | null;
  // Joined from glossary_terms
  term: string;
  definition: string;
  trackId: string;
}

/**
 * Cheap count of due cards for the header badge.
 * Uses the review_cards_learner_due index (learnerId, due).
 */
export async function getDueCount(
  db: Db,
  learnerId: string,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await import('drizzle-orm');
  const [row] = await db
    .select({ value: count() })
    .from(s.reviewCards)
    .where(
      and(
        eq(s.reviewCards.learnerId, learnerId),
        lte(s.reviewCards.due, now),
      ),
    );
  return Number(row?.value ?? 0);
}

/**
 * Returns cards with due ≤ now, joined to their glossary term,
 * ordered by due ASC (most overdue first), limited to `limit`.
 */
export async function getDueCards(
  db: Db,
  learnerId: string,
  now: Date = new Date(),
  limit = 20,
): Promise<DueCardRow[]> {
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
        eq(s.reviewCards.learnerId, learnerId),
        lte(s.reviewCards.due, now),
      ),
    )
    .orderBy(s.reviewCards.due)
    .limit(limit);

  return rows as DueCardRow[];
}

export interface ReviewItem {
  cardId: string;
  question: string;
  options: string[];
  /** Server-side only — NOT sent to client. Index into options array. */
  correctIndex: number;
}

/**
 * Builds a multiple-choice review item from a due card.
 *
 * - question: `What is "{term}"?`
 * - options: [correct definition, up to 3 distractors] — deterministically shuffled by card id (no Math.random)
 * - correctIndex: tracked server-side
 *
 * Distractors come from OTHER glossary definitions (pad with generic strings when <3 exist).
 */
export function buildReviewItem(
  card: Pick<DueCardRow, 'id' | 'term' | 'definition'>,
  distractorDefinitions: string[],
): ReviewItem {
  // Pad distractors to exactly 3 if needed
  const distractors = distractorDefinitions.slice(0, 3);
  while (distractors.length < 3) {
    distractors.push(GENERIC_DISTRACTORS[distractors.length % GENERIC_DISTRACTORS.length]);
  }

  const seed = hashString(card.id);
  // Shuffle the distractors using the card id as seed, then take the first 3
  const shuffledDistractors = lcgShuffle(distractors, seed).slice(0, 3);

  // Build the full option set: correct def + 3 distractors
  const unshuffled = [card.definition, ...shuffledDistractors];

  // Shuffle all 4 options with seed + 1 so the position of the correct answer is also randomized
  const shuffledOptions = lcgShuffle(unshuffled, hashString(card.id + ':options'));
  const correctIndex = shuffledOptions.indexOf(card.definition);

  return {
    cardId: card.id,
    question: `What is "${card.term}"?`,
    options: shuffledOptions,
    correctIndex,
  };
}

/**
 * Shared helper used by both the GET /due route and the POST /[cardId] grade route.
 *
 * Fetches distractors deterministically (the learner's other glossary definitions,
 * ordered by term ASC, take first 3) and builds the MC item with `buildReviewItem`.
 *
 * Determinism: same card id → same distractor set → same shuffled option order.
 * The POST route recomputes this identically from the card id so no correctIndex
 * needs to travel to the client.
 */
export async function assembleReviewItem(
  db: Db,
  card: DueCardRow,
): Promise<ReviewItem> {
  // Distractors: the learner's other glossary definitions across all their tracks,
  // ordered by term ASC (alphabetical, deterministic), excluding this card's own term.
  // v2 improvement: prefer same-track distractors for higher conceptual relevance.
  const distractorRows = await db
    .select({
      definition: s.glossaryTerms.definition,
      term: s.glossaryTerms.term,
    })
    .from(s.glossaryTerms)
    .innerJoin(s.reviewCards, eq(s.reviewCards.glossaryTermId, s.glossaryTerms.id))
    .where(
      and(
        eq(s.reviewCards.learnerId, card.learnerId),
        ne(s.reviewCards.id, card.id), // exclude the card being reviewed
      ),
    )
    .orderBy(asc(s.glossaryTerms.term))
    .limit(3);

  const distractorDefinitions = distractorRows.map((r) => r.definition);
  return buildReviewItem(card, distractorDefinitions);
}

export interface GradeReviewOpts {
  cardId: string;
  learnerId: string;
  correct: boolean;
  now?: Date;
}

export interface GradeReviewResult {
  /** The FSRS rating applied (Good=3 or Again=1). */
  rating: Rating.Good | Rating.Again;
  /** Next due date according to FSRS. */
  nextDue: Date;
  /** Scheduled days until next review (0 if still in learning/relearning steps). */
  scheduledDays: number;
  /**
   * Whether FSRS was actually applied this call.
   * false when the idempotency guard fires (card's last_review is within 2s of now),
   * which prevents duplicate review_log rows from a double-submit race.
   */
  applied: boolean;
}

/**
 * Grades a review answer and updates card state.
 *
 * Rating map (v1):
 *   correct  → Rating.Good  (3)
 *   incorrect → Rating.Again (1)
 *
 * Side-effects:
 *  1. Updates review_cards row with new FSRS card state.
 *  2. Inserts review_log row (ALL FSRSHistory fields).
 *  3. Inserts attempt_event (eventType='review', payload={cardId, glossaryTermId}).
 *
 * Ownership: cardId must belong to learnerId or this throws.
 */
export async function gradeReview(db: Db, opts: GradeReviewOpts): Promise<GradeReviewResult> {
  const now = opts.now ?? new Date();

  return db.transaction(async (tx) => {
    // Row-level lock: serialize concurrent gradeReview calls for the same card.
    // This prevents duplicate review_log rows from a double-submit race.
    await tx.execute(sql`SELECT id FROM review_cards WHERE id = ${opts.cardId} FOR UPDATE`);

    // Ownership check — also loads current card state (after the lock is held)
    const [cardRow] = await tx
      .select()
      .from(s.reviewCards)
      .where(and(eq(s.reviewCards.id, opts.cardId), eq(s.reviewCards.learnerId, opts.learnerId)))
      .limit(1);

    if (!cardRow) {
      throw new Error('review card not found or not owned by learner', { cause: { cardId: opts.cardId, learnerId: opts.learnerId } });
    }

    if (!cardRow.glossaryTermId) {
      throw new Error('review card has no glossary term', { cause: { cardId: opts.cardId } });
    }

    // Idempotency guard: if the card was reviewed within 2 seconds of `now`, treat
    // this as a duplicate submit and return the current state without re-applying FSRS.
    // The serialized loser of a double-click race will see the winner's lastReview after
    // acquiring the lock, hit this guard, and return applied:false with the current state.
    const DUPLICATE_WINDOW_MS = 2000;
    if (
      cardRow.lastReview !== null &&
      Math.abs(now.getTime() - cardRow.lastReview.getTime()) < DUPLICATE_WINDOW_MS
    ) {
      return {
        rating: opts.correct ? Rating.Good : Rating.Again,
        nextDue: cardRow.due,
        scheduledDays: cardRow.scheduledDays,
        applied: false,
      };
    }

    // Reconstruct ts-fsrs Card from DB row
    const currentCard: Card = {
      due: cardRow.due,
      stability: cardRow.stability,
      difficulty: cardRow.difficulty,
      elapsed_days: cardRow.elapsedDays,
      scheduled_days: cardRow.scheduledDays,
      learning_steps: cardRow.learningSteps,
      reps: cardRow.reps,
      lapses: cardRow.lapses,
      state: cardRow.state as Card['state'],
      last_review: cardRow.lastReview ?? undefined,
    };

    // Deterministic v1 rating map
    const rating: Rating.Good | Rating.Again = opts.correct ? Rating.Good : Rating.Again;

    const f = fsrs();
    const result = f.next(currentCard, now, rating);
    const nextCard = result.card;
    const log: ReviewLog = result.log;

    // Update review_cards with new FSRS state
    await tx
      .update(s.reviewCards)
      .set(cardToDbFields(nextCard))
      .where(eq(s.reviewCards.id, opts.cardId));

    // Insert review_log with ALL FSRSHistory fields
    await tx.insert(s.reviewLog).values({
      cardId: opts.cardId,
      rating: log.rating as number,
      state: log.state as number,
      due: log.due,
      stability: log.stability,
      difficulty: log.difficulty,
      elapsedDays: log.elapsed_days,
      scheduledDays: log.scheduled_days,
      lastElapsedDays: log.last_elapsed_days,
      learningSteps: log.learning_steps,
      reviewedAt: now,
    });

    // Insert attempt_event for review (eventType='review', widened per Phase 5 plan)
    await tx.insert(s.attemptEvents).values({
      learnerId: opts.learnerId,
      lessonId: null,
      blockId: opts.cardId,
      eventType: 'review',
      correct: opts.correct,
      payload: { cardId: opts.cardId, glossaryTermId: cardRow.glossaryTermId },
    });

    return {
      rating,
      nextDue: nextCard.due,
      scheduledDays: nextCard.scheduled_days,
      applied: true,
    };
  });
}
