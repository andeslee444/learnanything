import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';
import type { AgeBand } from '@/lib/age-band';

type Db = NodePgDatabase<typeof s>;

/** Idempotent: returns the existing learner if one exists for this user. */
export async function createLearner(
  db: Db,
  input: { userId: string; displayName: string; ageBand: AgeBand }
) {
  const existing = await getLearnerByUserId(db, input.userId);
  if (existing) return existing;
  const [learner] = await db
    .insert(s.learners)
    .values(input)
    .onConflictDoNothing({ target: s.learners.userId })
    .returning();
  // Concurrent duplicate insert: onConflictDoNothing returns no row — re-read.
  return learner ?? (await getLearnerByUserId(db, input.userId))!;
}

export async function getLearnerByUserId(db: Db, userId: string) {
  const [learner] = await db.select().from(s.learners).where(eq(s.learners.userId, userId));
  return learner ?? null;
}
