/**
 * lesson_narrations — TTS audio cache (Phase 8).
 *
 * Audio is stored as bytea (v1, founder-scale: no blob vendor needed at current
 * volume; migrate to object storage if lesson count exceeds ~10k or if row size
 * regularly exceeds 1 MB). The mimeType column carries 'audio/wav' (fake/silent
 * WAV in test/fake mode) or 'audio/mpeg' (OpenAI mp3 in production).
 *
 * The UNIQUE constraint on lessonId is the 1:1 relationship backstop and the
 * idempotency guard for the POST route (ON CONFLICT DO NOTHING + re-read).
 */
import { pgTable, text, timestamp, uuid, customType } from 'drizzle-orm/pg-core';
import { lessons } from './lessons';

// bytea custom type — drizzle-orm has no built-in bytea helper.
// data: Buffer (Node.js buffer); driverData: Buffer (pg returns Buffer for bytea columns).
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(val: Buffer) {
    return val;
  },
  fromDriver(val: Buffer) {
    return val;
  },
});

export const lessonNarrations = pgTable('lesson_narrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  lessonId: uuid('lesson_id')
    .notNull()
    .unique()
    .references(() => lessons.id, { onDelete: 'cascade' }),
  // 'audio/wav' (fake/test) or 'audio/mpeg' (OpenAI TTS production)
  mimeType: text('mime_type').notNull(),
  // bytea — v1 local storage (see file header comment above)
  audio: bytea('audio').notNull(),
  // Full narration transcript for accessibility ("captions promise")
  transcript: text('transcript').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
