import { pgTable, timestamp, integer, real, smallint, uuid, text, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { learners } from './learners';
import { glossaryTerms, learningRecords } from './records';

// Mirrors the ts-fsrs Card object 1:1 (spec §4). `state`: 0=New 1=Learning 2=Review 3=Relearning.
export const reviewCards = pgTable(
  'review_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    learnerId: uuid('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
    glossaryTermId: uuid('glossary_term_id').references(() => glossaryTerms.id, { onDelete: 'cascade' }),
    learningRecordId: uuid('learning_record_id').references(() => learningRecords.id, { onDelete: 'cascade' }),
    due: timestamp('due', { withTimezone: true }).notNull(),
    stability: real('stability').notNull().default(0),
    difficulty: real('difficulty').notNull().default(0),
    elapsedDays: integer('elapsed_days').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    state: smallint('state').notNull().default(0),
    lastReview: timestamp('last_review', { withTimezone: true }),
  },
  (t) => [
    // Exactly one source: glossary term XOR learning record (spec §4 dual-FK rule).
    check(
      'review_cards_one_source',
      sql`(${t.glossaryTermId} IS NOT NULL) <> (${t.learningRecordId} IS NOT NULL)`
    ),
    // Hot path: "which cards are due today for this learner"
    index('review_cards_learner_due').on(t.learnerId, t.due),
  ]
);

export const reviewLog = pgTable('review_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull().references(() => reviewCards.id, { onDelete: 'cascade' }),
  rating: smallint('rating').notNull(), // 1=Again 2=Hard 3=Good 4=Easy — deterministic mapping, never LLM-chosen
  state: smallint('state').notNull(),
  due: timestamp('due', { withTimezone: true }).notNull(),
  stability: real('stability').notNull(),
  difficulty: real('difficulty').notNull(),
  elapsedDays: integer('elapsed_days').notNull(),
  scheduledDays: integer('scheduled_days').notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Reserved for v1.x (spec §4: "schema reserved, not active in v1") ──────────
export const conceptAbility = pgTable('concept_ability', {
  id: uuid('id').primaryKey().defaultRandom(),
  learnerId: uuid('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  conceptKey: text('concept_key').notNull(), // skill-node name or glossary term key
  rating: real('rating').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const itemDifficulty = pgTable('item_difficulty', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemKey: text('item_key').notNull().unique(), // stable hash of generated quiz item
  difficulty: real('difficulty').notNull().default(0), // LLM-emitted prior, updated on attempts
  attempts: integer('attempts').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
