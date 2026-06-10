import { pgTable, text, timestamp, jsonb, integer, real, boolean, uuid, pgEnum, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tracks, learners } from './learners';

export const lessonStatus = pgEnum('lesson_status', ['generating', 'queued', 'ready', 'failed', 'needs_review']);
export const verificationStatus = pgEnum('verification_status', ['pending', 'verified', 'issues']);
export const moderationStatus = pgEnum('moderation_status', ['pending', 'approved', 'rejected']);

export const lessons = pgTable(
  'lessons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
    // App-assigned per-track sequence. Convention: assign inside a transaction that
    // takes SELECT ... FOR UPDATE on the parent track row (or retry on unique violation).
    // The (track_id, seq) unique index is the backstop.
    seq: integer('seq').notNull(),
    spec: jsonb('spec').notNull(), // LessonSpec (Zod-validated at write time)
    content: jsonb('content'), // generated blocks
    citations: jsonb('citations').notNull().default([]),
    status: lessonStatus('status').notNull().default('generating'),
    verificationStatus: verificationStatus('verification_status').notNull().default('pending'),
    faithfulnessScore: real('faithfulness_score'),
    zpdSnapshot: jsonb('zpd_snapshot').notNull().default({}),
    modelVersion: text('model_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lessons_track_seq').on(t.trackId, t.seq),
    index('lessons_track_status').on(t.trackId, t.status),
    uniqueIndex('lessons_one_generating_per_track').on(t.trackId).where(sql`${t.status} = 'generating'`),
  ]
);

// Deliberate: no back-pointer column on lessons — the unique FK here IS the 1:1 relationship (reverse lookup is an indexed seek).
export const sharedLessons = pgTable('shared_lessons', {
  id: uuid('id').primaryKey().defaultRandom(),
  lessonId: uuid('lesson_id').notNull().unique().references(() => lessons.id, { onDelete: 'cascade' }),
  sanitizedContent: jsonb('sanitized_content').notNull(),
  slug: text('slug').notNull().unique(), // {topic-slug}-{shortid}
  moderationStatus: moderationStatus('moderation_status').notNull().default('pending'),
  verificationStatus: verificationStatus('verification_status').notNull().default('pending'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const attemptEvents = pgTable(
  'attempt_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    learnerId: uuid('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
    lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
    blockId: text('block_id'),
    eventType: text('event_type').notNull(), // 'quiz_answer' | 'win_check' | 'review' | ...
    correct: boolean('correct'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('attempt_events_learner_lesson').on(t.learnerId, t.lessonId)]
);
