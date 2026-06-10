import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgTable, text, timestamp, integer, uuid, pgEnum, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { user } from './auth';

export const creditEntryType = pgEnum('credit_entry_type', ['purchase', 'grant', 'hold', 'capture', 'refund']);

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    entryType: creditEntryType('entry_type').notNull(),
    amount: integer('amount').notNull(), // grant +N, hold -1, refund +1, capture 0
    relatedEntryId: uuid('related_entry_id').references((): AnyPgColumn => creditLedger.id), // capture/refund → the hold they settle
    lessonId: uuid('lesson_id'), // soft reference; lessons may be deleted independently
    stripeRef: text('stripe_ref'), // null until Phase 9 (Stripe)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_ledger_user_created').on(t.userId, t.createdAt),
    // Structurally impossible double-settle, independent of tx isolation level.
    uniqueIndex('credit_ledger_one_settle_per_hold').on(t.relatedEntryId).where(sql`${t.relatedEntryId} IS NOT NULL`),
    // "Only holds deduct" as a DB fact, not a code convention.
    check('credit_ledger_amount_by_type', sql`(${t.entryType} = 'hold' AND ${t.amount} = -1) OR (${t.entryType} = 'capture' AND ${t.amount} = 0) OR (${t.entryType} IN ('grant', 'purchase', 'refund') AND ${t.amount} > 0)`),
  ]
);
