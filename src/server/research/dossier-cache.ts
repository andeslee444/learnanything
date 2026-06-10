import { and, eq, gt, sql, desc } from 'drizzle-orm';
import { cosineDistance } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';
import { embedText } from './embeddings';
import type { DossierContent } from './types';

type Db = NodePgDatabase<typeof s>;

export const SIMILARITY_THRESHOLD = 0.92; // spec §5
const DAY_MS = 86_400_000;

/** Per-vertical dossier TTLs (spec §5 freshness bands). */
export const TTL_DAYS_BY_VERTICAL: Record<string, number> = {
  programming: 10,
  history: 180,
};
const DEFAULT_TTL_DAYS = 30;

export function ttlForVertical(vertical: string, now = new Date()): Date {
  const days = TTL_DAYS_BY_VERTICAL[vertical] ?? DEFAULT_TTL_DAYS;
  return new Date(now.getTime() + days * DAY_MS);
}

export type DossierKey = { vertical: string; topic: string; levelBand: 'novice' | 'developing' | 'competent' };

// Re-export from shared types so consumers don't need a direct import cycle.
export type { DossierContent } from './types';

export async function findDossier(db: Db, key: DossierKey) {
  const embedding = await embedText(key.topic);
  const similarity = sql<number>`1 - (${cosineDistance(s.topicDossiers.embedding, embedding)})`;
  const [hit] = await db
    .select({
      id: s.topicDossiers.id,
      topic: s.topicDossiers.topic,
      sources: s.topicDossiers.sources,
      claims: s.topicDossiers.claims,
      glossarySeeds: s.topicDossiers.glossarySeeds,
      misconceptions: s.topicDossiers.misconceptions,
      similarity,
    })
    .from(s.topicDossiers)
    .where(
      and(
        eq(s.topicDossiers.vertical, key.vertical),
        eq(s.topicDossiers.levelBand, key.levelBand),
        gt(s.topicDossiers.ttlExpiresAt, new Date())
      )
    )
    .orderBy(desc(similarity))
    .limit(1);
  if (!hit || hit.similarity < SIMILARITY_THRESHOLD) return null;
  return hit;
}

export async function saveDossier(db: Db, key: DossierKey, content: DossierContent, modelVersion: string) {
  const embedding = await embedText(key.topic);
  const [row] = await db
    .insert(s.topicDossiers)
    .values({
      vertical: key.vertical,
      topic: key.topic,
      levelBand: key.levelBand,
      embedding,
      sources: content.sources,
      claims: content.claims,
      glossarySeeds: content.glossarySeeds,
      misconceptions: content.misconceptions,
      modelVersion,
      ttlExpiresAt: ttlForVertical(key.vertical),
    })
    .returning({ id: s.topicDossiers.id });
  return row.id;
}
