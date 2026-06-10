import { pgTable, text, timestamp, jsonb, integer, uuid, pgEnum, type AnyPgColumn, uniqueIndex } from 'drizzle-orm/pg-core';
import { tracks } from './learners';

export const recordType = pgEnum('record_type', [
  'demonstrated_understanding',
  'prior_knowledge',
  'corrected_misconception',
  'mission_shift',
]);
export const recordStatus = pgEnum('record_status', ['active', 'superseded']);

export const learningRecords = pgTable(
  'learning_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(), // per-track sequence (mirrors teach-skill 0001- numbering)
    recordType: recordType('record_type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(), // 1-3 sentences
    evidence: jsonb('evidence').notNull().default({}), // attempt_event ids, quiz answers, cited prior experience
    implications: text('implications'),
    status: recordStatus('status').notNull().default('active'),
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => learningRecords.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('learning_records_track_seq').on(t.trackId, t.seq)]
);

export const glossaryTerms = pgTable(
  'glossary_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
    term: text('term').notNull(),
    definition: text('definition').notNull(), // 1-2 sentences, what it IS
    avoidAliases: text('avoid_aliases').array().notNull().default([]),
    cluster: text('cluster'), // optional subheading grouping
    ambiguityNote: text('ambiguity_note'),
    // Promotion gate (spec §4): a term enters only with evidence behind it.
    promotionEvidenceRecordId: uuid('promotion_evidence_record_id')
      .notNull()
      .references(() => learningRecords.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('glossary_terms_track_term').on(t.trackId, t.term)]
);
