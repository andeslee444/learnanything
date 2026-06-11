import { pgTable, text, timestamp, jsonb, integer, uuid, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { lessons } from './lessons';

export const blockVerificationStatus = pgEnum('block_verification_status', [
  'checking',
  'verified',
  'unverified',
  'regenerated',
]);

/**
 * Per-block verification results.
 *
 * blockId convention: "block-{i}" where i is the 0-based index of the block
 * in lesson.content.blocks. Established here and consumed in verifyBlock().
 *
 * The unique index on (lesson_id, block_id) is the idempotency backstop:
 * ON CONFLICT (lesson_id, block_id) DO UPDATE lets verifyBlock upsert safely.
 */
export const verificationResults = pgTable(
  'verification_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    // blockId = "block-{i}" (array index, 0-based). See verifyBlock() for consumption.
    blockId: text('block_id').notNull(),
    status: blockVerificationStatus('status').notNull().default('checking'),
    claimsTotal: integer('claims_total').notNull().default(0),
    claimsVerified: integer('claims_verified').notNull().default(0),
    // Per-claim detail array: [{claim: string, verdict: 'supported'|'unsupported', sourceUrl?: string}]
    details: jsonb('details').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency backstop — verifyBlock upserts ON CONFLICT (lesson_id, block_id) DO UPDATE
    uniqueIndex('verification_results_lesson_block').on(t.lessonId, t.blockId),
  ],
);
