import { pgTable, text, timestamp, jsonb, uuid, pgEnum } from 'drizzle-orm/pg-core';
import { tracks } from './learners';
import { learningRecords } from './records';

export const missionStatus = pgEnum('mission_status', ['active', 'archived']);

export const missions = pgTable('missions', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackId: uuid('track_id').notNull().unique().references(() => tracks.id, { onDelete: 'cascade' }),
  whyText: text('why_text').notNull(),
  successCriteria: jsonb('success_criteria').notNull().default([]), // [{description, observable}]
  constraints: jsonb('constraints').notNull().default({}), // {timePerWeek, deadline, budget, prefs}
  outOfScope: text('out_of_scope').array().notNull().default([]),
  status: missionStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const missionRevisions = pgTable('mission_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  missionId: uuid('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  priorSnapshot: jsonb('prior_snapshot').notNull(),
  reason: text('reason').notNull(),
  linkedLearningRecordId: uuid('linked_learning_record_id').references(() => learningRecords.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
