import { pgTable, text, timestamp, jsonb, uuid, pgEnum, vector, index, unique } from 'drizzle-orm/pg-core';
import { expertiseBand } from './learners';

export const trustTier = pgEnum('trust_tier', ['tier1', 'tier2', 'tier3', 'blocked']);

export const topicDossiers = pgTable(
  'topic_dossiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vertical: text('vertical').notNull(),
    topic: text('topic').notNull(),
    levelBand: expertiseBand('level_band').notNull(),
    // 1536 dims = text-embedding-3-small; revisit when the embedding model is chosen in Phase 3.
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    sources: jsonb('sources').notNull().default([]),
    claims: jsonb('claims').notNull().default([]),
    glossarySeeds: jsonb('glossary_seeds').notNull().default([]),
    misconceptions: jsonb('misconceptions').notNull().default([]),
    modelVersion: text('model_version'),
    ttlExpiresAt: timestamp('ttl_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('topic_dossiers_embedding').using('hnsw', t.embedding.op('vector_cosine_ops'))]
);

export const trustDomains = pgTable(
  'trust_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vertical: text('vertical'), // null = global (the blocklist is global)
    domain: text('domain').notNull(),
    tier: trustTier('tier').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('trust_domains_vertical_domain').on(t.vertical, t.domain).nullsNotDistinct(),
  ]
);
