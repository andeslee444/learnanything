import { desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;
// Extract the transaction object type from the callback signature so it stays
// in sync automatically as drizzle-orm evolves.
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const createTrackInput = z.object({
  topic: z.string().min(3).max(200),
  vertical: z.enum(['programming', 'history']), // launch verticals (spec decision log)
  whyText: z.string().min(3).max(2000),
  successCriteria: z.array(z.object({ description: z.string().min(3).max(300) })).min(1).max(5),
  constraints: z.object({
    timePerWeek: z.string().max(100).optional(),
    deadline: z.string().max(100).optional(),
    notes: z.string().max(500).optional(),
  }),
  priorKnowledge: z.string().max(2000).optional(),
  outOfScope: z.array(z.string().min(2).max(100)).max(10),
});
export type CreateTrackInput = z.infer<typeof createTrackInput>;

/**
 * Per-track sequence convention (see schema comment on learning_records.seq):
 * lock the track row FOR UPDATE, then MAX(seq)+1.
 */
export async function nextRecordSeq(tx: Tx, trackId: string): Promise<number> {
  await tx.execute(sql`SELECT id FROM tracks WHERE id = ${trackId} FOR UPDATE`);
  const [row] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${s.learningRecords.seq}), 0)::int` })
    .from(s.learningRecords)
    .where(eq(s.learningRecords.trackId, trackId));
  return row.max + 1;
}

/** Creates track + mission (+ a prior_knowledge record if stated) in one transaction. */
export async function createTrackWithMission(db: Db, learnerId: string, input: CreateTrackInput) {
  return db.transaction(async (tx) => {
    const [track] = await tx
      .insert(s.tracks)
      .values({ learnerId, topic: input.topic, vertical: input.vertical })
      .returning();
    await tx.insert(s.missions).values({
      trackId: track.id,
      whyText: input.whyText,
      successCriteria: input.successCriteria,
      constraints: input.constraints,
      outOfScope: input.outOfScope,
    });
    if (input.priorKnowledge && input.priorKnowledge.trim().length > 0) {
      const seq = await nextRecordSeq(tx, track.id);
      await tx.insert(s.learningRecords).values({
        trackId: track.id,
        seq,
        recordType: 'prior_knowledge',
        title: 'Stated prior knowledge (onboarding)',
        body: input.priorKnowledge.trim().slice(0, 1000),
        evidence: { source: 'mission_interview' },
      });
    }
    return track;
  });
}

export async function listTracks(db: Db, learnerId: string) {
  return db.select().from(s.tracks).where(eq(s.tracks.learnerId, learnerId)).orderBy(desc(s.tracks.createdAt));
}

export async function getTrackDetail(db: Db, trackId: string, learnerId: string) {
  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, trackId));
  if (!track || track.learnerId !== learnerId) return null; // ownership check
  const [mission] = await db.select().from(s.missions).where(eq(s.missions.trackId, trackId));
  const nodes = await db.select().from(s.skillNodes).where(eq(s.skillNodes.trackId, trackId));
  return { track, mission: mission ?? null, nodes };
}
