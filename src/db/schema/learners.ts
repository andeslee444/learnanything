import { pgTable, text, timestamp, boolean, jsonb, real, uuid, pgEnum, index } from 'drizzle-orm/pg-core';
import { user } from './auth';

export const ageBand = pgEnum('age_band', ['13_15', '16_17', '18_plus']);
export const provenance = pgEnum('provenance', ['consumer', 'school']);
export const expertiseBand = pgEnum('expertise_band', ['novice', 'developing', 'competent']);
export const trackStatus = pgEnum('track_status', ['active', 'paused', 'completed', 'archived']);

export const learners = pgTable('learners', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  ageBand: ageBand('age_band').notNull(),
  provenance: provenance('provenance').notNull().default('consumer'),
  // Reserved for Kids mode / family accounts (spec §4) — unused in v1:
  parentUserId: text('parent_user_id').references(() => user.id),
  profile: jsonb('profile').notNull().default({}), // soft prefs/engagement notes
  fsrsParams: real('fsrs_params').array(), // per-learner FSRS weights, null = defaults
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tracks = pgTable(
  'tracks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    learnerId: uuid('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    vertical: text('vertical').notNull(), // 'programming' | 'history' at launch; free text by design
    status: trackStatus('status').notNull().default('active'),
    expertiseBand: expertiseBand('expertise_band').notNull().default('novice'),
    communityOptOut: boolean('community_opt_out').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tracks_learner_id').on(t.learnerId)]
);
