import { pgTable, text, timestamp, jsonb, integer, real, boolean, uuid, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { tracks, learners } from './learners.js';

export const lessonStatus = pgEnum('lesson_status', ['generating', 'queued', 'ready', 'failed', 'needs_review']);
export const verificationStatus = pgEnum('verification_status', ['pending', 'verified', 'issues']);
export const moderationStatus = pgEnum('moderation_status', ['pending', 'approved', 'rejected']);

export const lessons = pgTable(
  'lessons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(), // app-assigned per-track sequence; same convention as learning_records.seq
    spec: jsonb('spec').notNull(), // LessonSpec (Zod-validated at write time)
    content: jsonb('content'), // generated blocks
    citations: jsonb('citations').notNull().default([]),
    status: lessonStatus('status').notNull().default('generating'),
    verificationStatus: verificationStatus('verification_status').notNull().default('pending'),
    faithfulnessScore: real('faithfulness_score'),
    zpdSnapshot: jsonb('zpd_snapshot').notNull().default({}),
    modelVersion: text('model_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('lessons_track_seq').on(t.trackId, t.seq)]
);

export const sharedLessons = pgTable('shared_lessons', {
  id: uuid('id').primaryKey().defaultRandom(),
  lessonId: uuid('lesson_id').notNull().unique().references(() => lessons.id, { onDelete: 'cascade' }),
  sanitizedContent: jsonb('sanitized_content').notNull(),
  slug: text('slug').notNull().unique(), // {topic-slug}-{shortid}
  moderationStatus: moderationStatus('moderation_status').notNull().default('pending'),
  verificationStatus: verificationStatus('verification_status').notNull().default('pending'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const attemptEvents = pgTable('attempt_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  learnerId: uuid('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
  blockId: text('block_id'),
  eventType: text('event_type').notNull(), // 'quiz_answer' | 'win_check' | 'review' | ...
  correct: boolean('correct'),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
