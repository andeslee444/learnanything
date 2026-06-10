import { pgTable, text, timestamp, jsonb, real, uuid, pgEnum, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tracks } from './learners';

export const nodeMastery = pgEnum('node_mastery', ['not_started', 'in_progress', 'demonstrated', 'mastered']);
export const resourceType = pgEnum('resource_type', ['book', 'article', 'video', 'docs', 'paper', 'community', 'local']);
export const resourceKind = pgEnum('resource_kind', ['knowledge', 'wisdom']);
export const resourceStatus = pgEnum('resource_status', ['active', 'pruned']);
export const resourceOrigin = pgEnum('resource_origin', ['exa', 'manual', 'user_upload']);
export const gapStatus = pgEnum('gap_status', ['open', 'resolved']);
export const refDocType = pgEnum('ref_doc_type', [
  'cheat_sheet', 'algorithm_flowchart', 'syntax_reference', 'routine', 'sequence', 'glossary_export',
]);

export const skillNodes = pgTable('skill_nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  summary: text('summary'),
  missionRelevance: real('mission_relevance').notNull().default(0.5), // 0..1, ranks the frontier
  mastery: nodeMastery('mastery').notNull().default('not_started'), // cached; derived from records
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const skillNodeEdges = pgTable(
  'skill_node_edges',
  {
    nodeId: uuid('node_id').notNull().references(() => skillNodes.id, { onDelete: 'cascade' }),
    prereqId: uuid('prereq_id').notNull().references(() => skillNodes.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.prereqId] }),
    check('skill_node_edges_no_self_loop', sql`${t.nodeId} <> ${t.prereqId}`),
  ]
);

export const resources = pgTable(
  'resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
    url: text('url'),
    title: text('title').notNull(),
    resourceType: resourceType('resource_type').notNull(),
    kind: resourceKind('kind').notNull(),
    annotation: text('annotation').notNull(), // mandatory: what it covers / when to reach for it
    trustRationale: text('trust_rationale'),
    status: resourceStatus('status').notNull().default('active'),
    prunedReason: text('pruned_reason'),
    origin: resourceOrigin('origin').notNull(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('resources_exa_requires_url', sql`${t.origin} <> 'exa' OR ${t.url} IS NOT NULL`),
  ]
);

export const resourceGaps = pgTable('resource_gaps', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  status: gapStatus('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const referenceDocs = pgTable('reference_docs', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  docType: refDocType('doc_type').notNull(),
  content: jsonb('content').notNull(), // structured doc; rendered with print CSS
  linkedLessonIds: uuid('linked_lesson_ids').array().notNull().default([]), // no FK: lessons table is a later domain
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
