import { and, eq, gte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;

export const FREE_MONTHLY_GRANT = 3;

export class InsufficientCreditsError extends Error {
  constructor() {
    super('Insufficient credits');
    this.name = 'InsufficientCreditsError';
  }
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Idempotent: grants FREE_MONTHLY_GRANT once per calendar month. No rollover by design. */
export async function ensureMonthlyGrant(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize concurrent grant checks per user (same advisory-lock pattern as placeHold).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const existing = await tx
      .select({ id: s.creditLedger.id })
      .from(s.creditLedger)
      .where(
        and(
          eq(s.creditLedger.userId, userId),
          eq(s.creditLedger.entryType, 'grant'),
          gte(s.creditLedger.createdAt, monthStart())
        )
      )
      .limit(1);
    if (existing.length === 0) {
      await tx.insert(s.creditLedger).values({ userId, entryType: 'grant', amount: FREE_MONTHLY_GRANT });
    }
  });
}

export async function balance(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${s.creditLedger.amount}), 0)::int` })
    .from(s.creditLedger)
    .where(eq(s.creditLedger.userId, userId));
  return row.total;
}

/** Deducts one credit as a hold. Throws InsufficientCreditsError if balance < 1. */
export async function placeHold(db: Db, userId: string, lessonId?: string): Promise<string> {
  return db.transaction(async (tx) => {
    // Serialize concurrent holds per user (advisory lock on the user id hash).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const [row] = await tx
      .select({ total: sql<number>`COALESCE(SUM(${s.creditLedger.amount}), 0)::int` })
      .from(s.creditLedger)
      .where(eq(s.creditLedger.userId, userId));
    if (row.total < 1) throw new InsufficientCreditsError();
    const [hold] = await tx
      .insert(s.creditLedger)
      .values({ userId, entryType: 'hold', amount: -1, lessonId })
      .returning();
    return hold.id;
  });
}

async function settleHold(db: Db, holdId: string, entryType: 'capture' | 'refund'): Promise<void> {
  await db.transaction(async (tx) => {
    const [hold] = await tx
      .select()
      .from(s.creditLedger)
      .where(and(eq(s.creditLedger.id, holdId), eq(s.creditLedger.entryType, 'hold')));
    if (!hold) throw new Error(`No hold found for id ${holdId}`);
    // Serialize settlement on the hold id so two settles can't both pass the check below.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${holdId}))`);
    const settled = await tx
      .select({ id: s.creditLedger.id })
      .from(s.creditLedger)
      .where(eq(s.creditLedger.relatedEntryId, holdId))
      .limit(1);
    if (settled.length > 0) throw new Error('Hold already settled');
    await tx.insert(s.creditLedger).values({
      userId: hold.userId,
      entryType,
      amount: entryType === 'refund' ? 1 : 0,
      relatedEntryId: holdId,
      lessonId: hold.lessonId ?? undefined,
    });
  });
}

export const captureHold = (db: Db, holdId: string) => settleHold(db, holdId, 'capture');
export const refundHold = (db: Db, holdId: string) => settleHold(db, holdId, 'refund');
