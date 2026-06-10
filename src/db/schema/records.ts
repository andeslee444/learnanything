import { pgTable, text, timestamp, jsonb, integer, uuid, pgEnum, type AnyPgColumn, uniqueIndex, index, foreignKey } from 'drizzle-orm/pg-core';
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
    // App-assigned per-track sequence. Convention: assign inside a transaction that
    // takes SELECT ... FOR UPDATE on the parent track row (or retry on unique violation).
    // The (track_id, seq) unique index is the backstop.
    seq: integer('seq').notNull(),
    recordType: recordType('record_type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(), // 1-3 sentences
    evidence: jsonb('evidence').notNull().default({}), // attempt_event ids, quiz answers, cited prior experience
    implications: text('implications'),
    status: recordStatus('status').notNull().default('active'),
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => learningRecords.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('learning_records_track_seq').on(t.trackId, t.seq),
    uniqueIndex('learning_records_id_track').on(t.id, t.trackId),
    index('learning_records_track_status').on(t.trackId, t.status),
  ]
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
    // The composite FK below ensures the evidence record belongs to the SAME track.
    promotionEvidenceRecordId: uuid('promotion_evidence_record_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('glossary_terms_track_term').on(t.trackId, t.term),
    foreignKey({
      columns: [t.promotionEvidenceRecordId, t.trackId],
      foreignColumns: [learningRecords.id, learningRecords.trackId],
      name: 'glossary_terms_evidence_same_track_fk',
    }).onDelete('cascade'),
  ]
);
