import { pgTable, text, timestamp, integer, uuid, pgEnum, index } from 'drizzle-orm/pg-core';
import { user } from './auth';

export const creditEntryType = pgEnum('credit_entry_type', ['purchase', 'grant', 'hold', 'capture', 'refund']);

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    entryType: creditEntryType('entry_type').notNull(),
    amount: integer('amount').notNull(), // grant +N, hold -1, refund +1, capture 0
    relatedEntryId: uuid('related_entry_id'), // capture/refund → the hold they settle
    lessonId: uuid('lesson_id'), // soft reference; lessons may be deleted independently
    stripeRef: text('stripe_ref'), // null until Phase 9 (Stripe)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credit_ledger_user_created').on(t.userId, t.createdAt)]
);
