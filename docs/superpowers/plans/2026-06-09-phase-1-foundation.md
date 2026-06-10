# Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the LearnAnything app skeleton: Next.js + Better-Auth + the complete vendor-neutral Postgres schema (with migrations and tests) + the minimal internal credit ledger + the "clear blue skies" design tokens.

**Architecture:** Single Next.js App Router app (TypeScript, `src/` layout). Drizzle ORM over node-postgres against Postgres 17 + pgvector (local Docker for dev/test; Neon in prod later). Better-Auth handles email/password auth via its Drizzle adapter. The schema implements spec §4 in full, including reserved-for-later tables. Credits are an append-only ledger with hardcoded free-tier grants (no Stripe in this phase).

**Tech Stack:** Next.js (App Router) · React 19 · Tailwind v4 · Drizzle ORM + drizzle-kit · Better-Auth · pg (node-postgres) · pgvector · Vitest · GitHub Actions

**Spec:** `docs/superpowers/specs/2026-06-09-learnanything-v1-design.md` (§2 table, §4, §11, §12 phase 1)

**Conventions for every commit in this plan:** commit with `--author="Andes Lee <andes.lee444@gmail.com>"` (required for Vercel deployments).

---

## File structure (end state of this phase)

```
├── docker-compose.yml              # local Postgres 17 + pgvector (dev + test DBs)
├── drizzle.config.ts               # drizzle-kit config
├── drizzle/                        # generated SQL migrations (committed)
├── vitest.config.ts
├── .env.example
├── .github/workflows/ci.yml
└── src/
    ├── app/
    │   ├── layout.tsx              # fonts, metadata, tokens applied
    │   ├── page.tsx                # landing placeholder using tokens
    │   ├── globals.css             # Tailwind v4 @theme design tokens
    │   └── api/auth/[...all]/route.ts
    ├── lib/
    │   ├── db.ts                   # drizzle client (pg Pool singleton)
    │   ├── auth.ts                 # Better-Auth server instance
    │   ├── auth-client.ts          # Better-Auth React client
    │   └── credits.ts              # ledger operations (grant/hold/capture/refund/balance)
    ├── db/schema/
    │   ├── index.ts                # re-exports all tables
    │   ├── auth.ts                 # user, session, account, verification (Better-Auth)
    │   ├── learners.ts             # learners, tracks
    │   ├── records.ts              # learning_records, glossary_terms
    │   ├── missions.ts             # missions, mission_revisions
    │   ├── knowledge.ts            # skill_nodes, skill_node_edges, resources, resource_gaps, reference_docs
    │   ├── lessons.ts              # lessons, shared_lessons, attempt_events
    │   ├── reviews.ts              # review_cards, review_log, concept_ability, item_difficulty (reserved)
    │   ├── research.ts             # topic_dossiers (pgvector), trust_domains
    │   └── billing.ts              # credit_ledger
    └── test/
        ├── global-setup.ts         # runs migrations against TEST_DATABASE_URL
        └── db.ts                   # test db client + resetDb() helper
```

Each schema file owns one domain; cross-file FKs only point "downward" (learners ← records ← missions; learners ← knowledge/lessons/reviews) so there are no import cycles.

---

### Task 1: Scaffold Next.js into the existing repo

The repo already contains `docs/` and `.claude/` (and `.git`). `create-next-app` may refuse a non-empty directory, so scaffold into a temp dir and copy in.

**Files:**
- Create: entire Next.js scaffold (`package.json`, `src/app/*`, `tsconfig.json`, etc.)
- Create: `.env.example`

- [ ] **Step 1: Scaffold in /tmp and copy into the repo root**

```bash
cd /Users/andeslee/Documents/Cursor-Projects/LearnAnything
npx create-next-app@latest /tmp/la-scaffold --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
cp -R /tmp/la-scaffold/. .
rm -rf /tmp/la-scaffold
npm install
```

- [ ] **Step 2: Verify the dev server boots**

Run: `npm run dev` → open http://localhost:3000 → default Next.js page renders. Stop the server.

- [ ] **Step 3: Create `.env.example`**

```bash
# .env.example
DATABASE_URL=postgres://learnanything:learnanything@localhost:5432/learnanything
TEST_DATABASE_URL=postgres://learnanything:learnanything@localhost:5432/learnanything_test
BETTER_AUTH_SECRET=generate-with-openssl-rand-base64-32
BETTER_AUTH_URL=http://localhost:3000
```

Copy to `.env.local` (gitignored by the scaffold) and fill `BETTER_AUTH_SECRET` with output of `openssl rand -base64 32`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "chore: scaffold Next.js app (TS, Tailwind v4, App Router)"
```

---

### Task 2: Vitest setup

**Files:**
- Create: `vitest.config.ts`
- Create: `src/lib/smoke.test.ts` (deleted in Task 3 once real tests exist)
- Modify: `package.json` (scripts)

- [ ] **Step 1: Install**

```bash
npm install -D vitest @vitest/coverage-v8 dotenv
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['dotenv/config'],
    fileParallelism: false, // tests share one Postgres database
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

(`src/test/global-setup.ts` arrives in Task 3 — until then create it as an empty `export default function () {}` so Vitest runs.)

- [ ] **Step 3: Write a smoke test** — `src/lib/smoke.test.ts`

```ts
import { describe, it, expect } from 'vitest';

describe('vitest wiring', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Add script and run**

In `package.json` scripts: `"test": "vitest run"`.

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "chore: add Vitest"
```

---

### Task 3: Local Postgres + Drizzle wiring

**Files:**
- Create: `docker-compose.yml`, `drizzle.config.ts`, `src/lib/db.ts`, `src/test/global-setup.ts`, `src/test/db.ts`, `src/db/schema/index.ts`
- Test: `src/test/connection.test.ts`
- Delete: `src/lib/smoke.test.ts`

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  db:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: learnanything
      POSTGRES_PASSWORD: learnanything
      POSTGRES_DB: learnanything
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init-test-db.sql:/docker-entrypoint-initdb.d/init-test-db.sql
volumes:
  pgdata:
```

Create `scripts/init-test-db.sql`:

```sql
CREATE DATABASE learnanything_test;
```

Run: `docker compose up -d` → `docker compose ps` shows db healthy/running.

- [ ] **Step 2: Install Drizzle**

```bash
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg
```

- [ ] **Step 3: Create `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

Note: drizzle-kit reads `.env` not `.env.local` — also create a `.env` symlink or duplicate the two DB URLs into `.env` (gitignore already covers `.env*`). Simplest: `cp .env.example .env` and fill the same values.

- [ ] **Step 4: Create `src/lib/db.ts`** (pool singleton — survives Next.js dev hot reload)

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';

const globalForDb = globalThis as unknown as { pool?: Pool };

export const pool =
  globalForDb.pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== 'production') globalForDb.pool = pool;

export const db = drizzle(pool, { schema });
```

- [ ] **Step 5: Create `src/db/schema/index.ts`** (empty for now)

```ts
// Re-exports every schema domain. Populated as tasks add files.
export {};
```

- [ ] **Step 6: Create test helpers**

`src/test/db.ts`:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';

export const testPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
export const testDb = drizzle(testPool, { schema });

/** Truncate all app tables between test files. Skips drizzle's migration bookkeeping. */
export async function resetDb() {
  const tables = await testDb.execute(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '__drizzle%'
  `);
  for (const row of tables.rows as { tablename: string }[]) {
    await testDb.execute(
      sql.raw(`TRUNCATE TABLE "${row.tablename}" RESTART IDENTITY CASCADE`)
    );
  }
}
```

`src/test/global-setup.ts` (replaces the Task 2 stub):

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import 'dotenv/config';

export default async function setup() {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  await pool.end();
}
```

- [ ] **Step 7: Write the failing connection test** — `src/test/connection.test.ts`

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { testDb, testPool } from './db';

describe('database connection', () => {
  it('answers SELECT 1', async () => {
    const result = await testDb.execute(sql`SELECT 1 AS one`);
    expect(result.rows[0]).toEqual({ one: 1 });
  });
});

afterAll(() => testPool.end());
```

Delete `src/lib/smoke.test.ts`.

- [ ] **Step 8: Run tests**

Run: `npm test`
Expected: PASS (migrations folder is empty so migrate() is a no-op; connection works).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "chore: local pgvector Postgres, Drizzle wiring, test harness"
```

---

### Task 4: Better-Auth (email/password)

**Files:**
- Create: `src/db/schema/auth.ts`, `src/lib/auth.ts`, `src/lib/auth-client.ts`, `src/app/api/auth/[...all]/route.ts`
- Modify: `src/db/schema/index.ts`
- Test: `src/test/auth.test.ts`

- [ ] **Step 1: Install**

```bash
npm install better-auth
```

- [ ] **Step 2: Create `src/db/schema/auth.ts`** (canonical Better-Auth core schema)

```ts
import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core';

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Verify field names against the installed version: `npx @better-auth/cli@latest generate --config src/lib/auth.ts` after Step 3 prints/creates the expected schema — if it differs from the above, adopt the generated version. (Field names occasionally change between Better-Auth minors; the generated output is the source of truth.)

In `src/db/schema/index.ts`, replace contents:

```ts
export * from './auth';
```

- [ ] **Step 3: Create `src/lib/auth.ts`**

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '@/lib/db';
import * as schema from '@/db/schema';

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true },
  // Age screen + learner-row creation arrive in Phase 2 (spec §12).
});
```

- [ ] **Step 4: Create the route handler** — `src/app/api/auth/[...all]/route.ts`

```ts
import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(auth);
```

- [ ] **Step 5: Create the React client** — `src/lib/auth-client.ts`

```ts
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();
export const { signIn, signUp, signOut, useSession } = authClient;
```

- [ ] **Step 6: Generate + run the migration**

```bash
npx drizzle-kit generate --name auth
npx drizzle-kit migrate
```

Expected: a new SQL file in `drizzle/` creating the four tables; migrate applies cleanly against the dev DB.

- [ ] **Step 7: Write the failing auth test** — `src/test/auth.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as schema from '@/db/schema';

const testAuth = betterAuth({
  database: drizzleAdapter(testDb, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true },
  secret: 'test-secret-test-secret-test-secret',
  baseURL: 'http://localhost:3000',
});

describe('better-auth signup', () => {
  beforeAll(resetDb);
  afterAll(() => testPool.end());

  it('creates a user row on email signup', async () => {
    await testAuth.api.signUpEmail({
      body: { name: 'Test Learner', email: 'test@example.com', password: 'a-strong-password-123' },
    });
    const rows = await testDb
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'test@example.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Test Learner');
  });
});
```

Run: `npm test` → Expected: PASS (global-setup migrated the test DB).
Note: each Vitest file runs in an isolated worker with its own `testPool` instance, so calling `testPool.end()` in one file does not affect others — include it or omit it freely (process exit cleans up).

- [ ] **Step 8: Manual smoke** — `npm run dev`, then:

```bash
curl -s http://localhost:3000/api/auth/ok
```

Expected: `{"ok":true}`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: Better-Auth email/password with Drizzle adapter"
```

---

### Task 5: Learner-domain schema (learners, tracks, missions)

Spec §4: `users` → `learners` (1:1 in v1, Kids-mode columns reserved) → `tracks`; missions UNIQUE per track with revision history.

**Files:**
- Create: `src/db/schema/learners.ts`, `src/db/schema/missions.ts`
- Modify: `src/db/schema/index.ts`
- Test: `src/test/learners.test.ts`

- [ ] **Step 1: Create `src/db/schema/learners.ts`**

```ts
import { pgTable, text, timestamp, boolean, jsonb, real, uuid, pgEnum } from 'drizzle-orm/pg-core';
import { user } from './auth';

export const ageBand = pgEnum('age_band', ['13_15', '16_17', '18_plus']);
export const provenance = pgEnum('provenance', ['consumer', 'school']);
export const expertiseBand = pgEnum('expertise_band', ['novice', 'developing', 'competent']);
export const trackStatus = pgEnum('track_status', ['active', 'paused', 'completed', 'archived']);

export const learners = pgTable('learners', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  ageBand: ageBand('age_band').notNull(),
  provenance: provenance('provenance').notNull().default('consumer'),
  // Reserved for Kids mode / family accounts (spec §4) — unused in v1:
  parentUserId: text('parent_user_id').references(() => user.id),
  profile: jsonb('profile').notNull().default({}), // soft prefs/engagement notes
  fsrsParams: real('fsrs_params').array(), // per-learner FSRS weights, null = defaults
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tracks = pgTable('tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  learnerId: uuid('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  topic: text('topic').notNull(),
  vertical: text('vertical').notNull(), // 'programming' | 'history' at launch; free text by design
  status: trackStatus('status').notNull().default('active'),
  expertiseBand: expertiseBand('expertise_band').notNull().default('novice'),
  communityOptOut: boolean('community_opt_out').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Create `src/db/schema/missions.ts`**

```ts
import { pgTable, text, timestamp, jsonb, uuid, pgEnum } from 'drizzle-orm/pg-core';
import { tracks } from './learners';
import { learningRecords } from './records';

export const missionStatus = pgEnum('mission_status', ['active', 'archived']);

export const missions = pgTable('missions', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackId: uuid('track_id').notNull().unique().references(() => tracks.id, { onDelete: 'cascade' }),
  whyText: text('why_text').notNull(),
  successCriteria: jsonb('success_criteria').notNull().default([]), // [{description, observable}]
  constraints: jsonb('constraints').notNull().default({}), // {timePerWeek, deadline, budget, prefs}
  outOfScope: text('out_of_scope').array().notNull().default([]),
  status: missionStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const missionRevisions = pgTable('mission_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  missionId: uuid('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  priorSnapshot: jsonb('prior_snapshot').notNull(),
  reason: text('reason').notNull(),
  linkedLearningRecordId: uuid('linked_learning_record_id').references(() => learningRecords.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

(`./records` is created in Task 6 — Tasks 5 and 6 generate **one combined migration** in Task 6 Step 4. Do not run drizzle-kit yet.)

- [ ] **Step 3: Update `src/db/schema/index.ts`**

```ts
export * from './auth';
export * from './learners';
export * from './records';
export * from './missions';
```

Continue to Task 6 before generating the migration.

---

### Task 6: Records + knowledge schema

Spec §4: ADR-style learning records with supersession; promotion-gated glossary; skill graph; annotated resources + gaps; reference docs.

**Files:**
- Create: `src/db/schema/records.ts`, `src/db/schema/knowledge.ts`
- Modify: `src/db/schema/index.ts`
- Test: `src/test/records.test.ts`

- [ ] **Step 1: Create `src/db/schema/records.ts`**

```ts
import { pgTable, text, timestamp, jsonb, integer, uuid, pgEnum, type AnyPgColumn, uniqueIndex } from 'drizzle-orm/pg-core';
import { tracks } from './learners';

export const recordType = pgEnum('record_type', [
  'demonstrated_understanding',
  'prior_knowledge',
  'corrected_misconception',
  'mission_shift',
]);
export const recordStatus = pgEnum('record_status', ['active', 'superseded']);

export const learningRecords = pgTable(
  'learning_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(), // per-track sequence (mirrors teach-skill 0001- numbering)
    recordType: recordType('record_type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(), // 1-3 sentences
    evidence: jsonb('evidence').notNull().default({}), // attempt_event ids, quiz answers, cited prior experience
    implications: text('implications'),
    status: recordStatus('status').notNull().default('active'),
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => learningRecords.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('learning_records_track_seq').on(t.trackId, t.seq)]
);

export const glossaryTerms = pgTable(
  'glossary_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
    term: text('term').notNull(),
    definition: text('definition').notNull(), // 1-2 sentences, what it IS
    avoidAliases: text('avoid_aliases').array().notNull().default([]),
    cluster: text('cluster'), // optional subheading grouping
    ambiguityNote: text('ambiguity_note'),
    // Promotion gate (spec §4): a term enters only with evidence behind it.
    promotionEvidenceRecordId: uuid('promotion_evidence_record_id')
      .notNull()
      .references(() => learningRecords.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('glossary_terms_track_term').on(t.trackId, t.term)]
);
```

- [ ] **Step 2: Create `src/db/schema/knowledge.ts`**

```ts
import { pgTable, text, timestamp, jsonb, real, uuid, pgEnum, primaryKey } from 'drizzle-orm/pg-core';
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
  (t) => [primaryKey({ columns: [t.nodeId, t.prereqId] })]
);

export const resources = pgTable('resources', {
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
});

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
```

- [ ] **Step 3: Update `src/db/schema/index.ts`**

```ts
export * from './auth';
export * from './learners';
export * from './records';
export * from './missions';
export * from './knowledge';
```

- [ ] **Step 4: Generate + run the combined migration (Tasks 5+6)**

```bash
npx drizzle-kit generate --name learner-domain
npx drizzle-kit migrate
```

Expected: one migration creating learners, tracks, missions, mission_revisions, learning_records, glossary_terms, skill_nodes, skill_node_edges, resources, resource_gaps, reference_docs + enums.

- [ ] **Step 5: Write the failing domain test** — `src/test/learners.test.ts`

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, resetDb } from './db';
import * as s from '@/db/schema';

async function seedLearnerTrack() {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'L', email: `${crypto.randomUUID()}@t.dev` })
    .returning();
  const [learner] = await testDb
    .insert(s.learners)
    .values({ userId: u.id, displayName: 'L', ageBand: '18_plus' })
    .returning();
  const [track] = await testDb
    .insert(s.tracks)
    .values({ learnerId: learner.id, topic: 'Rust CLI tools', vertical: 'programming' })
    .returning();
  return { learner, track };
}

describe('learner domain', () => {
  beforeAll(resetDb);

  it('enforces one mission per track', async () => {
    const { track } = await seedLearnerTrack();
    await testDb.insert(s.missions).values({ trackId: track.id, whyText: 'ship a CLI to my team' });
    await expect(
      testDb.insert(s.missions).values({ trackId: track.id, whyText: 'second mission' })
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('supports learning-record supersession', async () => {
    const { track } = await seedLearnerTrack();
    const [first] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id, seq: 1, recordType: 'prior_knowledge',
        title: 'Knows basic syntax', body: 'Claimed prior experience with Rust syntax.',
      })
      .returning();
    const [second] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id, seq: 2, recordType: 'corrected_misconception',
        title: 'Borrow checker misunderstanding corrected', body: 'Understood moves vs borrows.',
      })
      .returning();
    await testDb
      .update(s.learningRecords)
      .set({ status: 'superseded', supersededById: second.id })
      .where(eq(s.learningRecords.id, first.id));

    const [reloaded] = await testDb
      .select().from(s.learningRecords).where(eq(s.learningRecords.id, first.id));
    expect(reloaded.status).toBe('superseded');
    expect(reloaded.supersededById).toBe(second.id);
  });

  it('gates glossary terms on a promotion-evidence record', async () => {
    const { track } = await seedLearnerTrack();
    await expect(
      testDb.insert(s.glossaryTerms).values({
        trackId: track.id, term: 'ownership', definition: 'Each value has a single owning binding.',
        // promotionEvidenceRecordId intentionally missing
      } as never)
    ).rejects.toThrow();
  });
});
```

Run: `npm test` → Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: learner-domain schema (learners, tracks, missions, records, glossary, skill graph, resources)"
```

---

### Task 7: Lesson domain schema

Spec §4: lessons (spec/content/citations/status/verification), shared_lessons (sanitized public copies), append-only attempt_events.

**Files:**
- Create: `src/db/schema/lessons.ts`
- Modify: `src/db/schema/index.ts` (add `export * from './lessons';`)
- Test: `src/test/lessons.test.ts`

- [ ] **Step 1: Create `src/db/schema/lessons.ts`**

```ts
import { pgTable, text, timestamp, jsonb, integer, real, boolean, uuid, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { tracks, learners } from './learners';

export const lessonStatus = pgEnum('lesson_status', ['generating', 'queued', 'ready', 'failed', 'needs_review']);
export const verificationStatus = pgEnum('verification_status', ['pending', 'verified', 'issues']);
export const moderationStatus = pgEnum('moderation_status', ['pending', 'approved', 'rejected']);

export const lessons = pgTable(
  'lessons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trackId: uuid('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    spec: jsonb('spec').notNull(), // LessonSpec (Zod-validated at write time)
    content: jsonb('content'), // generated blocks
    citations: jsonb('citations').notNull().default([]),
    status: lessonStatus('status').notNull().default('generating'),
    verificationStatus: verificationStatus('verification_status').notNull().default('pending'),
    faithfulnessScore: real('faithfulness_score'),
    zpdSnapshot: jsonb('zpd_snapshot').notNull().default({}),
    modelVersion: text('model_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('lessons_track_seq').on(t.trackId, t.seq)]
);

export const sharedLessons = pgTable('shared_lessons', {
  id: uuid('id').primaryKey().defaultRandom(),
  lessonId: uuid('lesson_id').notNull().unique().references(() => lessons.id, { onDelete: 'cascade' }),
  sanitizedContent: jsonb('sanitized_content').notNull(),
  slug: text('slug').notNull().unique(), // {topic-slug}-{shortid}
  moderationStatus: moderationStatus('moderation_status').notNull().default('pending'),
  verificationStatus: verificationStatus('verification_status').notNull().default('pending'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const attemptEvents = pgTable('attempt_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  learnerId: uuid('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
  blockId: text('block_id'),
  eventType: text('event_type').notNull(), // 'quiz_answer' | 'win_check' | 'review' | ...
  correct: boolean('correct'),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate + migrate**

```bash
npx drizzle-kit generate --name lessons
npx drizzle-kit migrate
```

- [ ] **Step 3: Write the failing test** — `src/test/lessons.test.ts`

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { testDb, resetDb } from './db';
import * as s from '@/db/schema';

describe('lesson domain', () => {
  let trackId: string;
  let learnerId: string;

  beforeAll(async () => {
    await resetDb();
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'L', email: 'lesson@t.dev' })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'L', ageBand: '16_17' })
      .returning();
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId: learner.id, topic: 'WW1 causes', vertical: 'history' })
      .returning();
    trackId = track.id;
    learnerId = learner.id;
  });

  it('stores a lesson and its attempt events', async () => {
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: { objective: 'Explain the alliance system' } })
      .returning();
    expect(lesson.status).toBe('generating');
    expect(lesson.verificationStatus).toBe('pending');

    const [event] = await testDb
      .insert(s.attemptEvents)
      .values({ learnerId, lessonId: lesson.id, eventType: 'quiz_answer', correct: true })
      .returning();
    expect(event.correct).toBe(true);
  });

  it('enforces unique slugs and one shared page per lesson', async () => {
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 2, spec: { objective: 'x' } })
      .returning();
    await testDb.insert(s.sharedLessons).values({
      lessonId: lesson.id, sanitizedContent: {}, slug: 'ww1-alliances-ab12',
    });
    await expect(
      testDb.insert(s.sharedLessons).values({
        lessonId: lesson.id, sanitizedContent: {}, slug: 'ww1-alliances-cd34',
      })
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
```

Run: `npm test` → Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: lesson domain schema (lessons, shared_lessons, attempt_events)"
```

---

### Task 8: Review + reserved-rating schema

Spec §4: ts-fsrs Card state with a dual-FK source (XOR), full review_log, and the reserved-not-active Elo tables.

**Files:**
- Create: `src/db/schema/reviews.ts`
- Modify: `src/db/schema/index.ts` (add `export * from './reviews';`)
- Test: `src/test/reviews.test.ts`

- [ ] **Step 1: Create `src/db/schema/reviews.ts`**

```ts
import { pgTable, timestamp, integer, real, smallint, uuid, text, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { learners } from './learners';
import { glossaryTerms, learningRecords } from './records';

// Mirrors the ts-fsrs Card object 1:1 (spec §4). `state`: 0=New 1=Learning 2=Review 3=Relearning.
export const reviewCards = pgTable(
  'review_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    learnerId: uuid('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
    glossaryTermId: uuid('glossary_term_id').references(() => glossaryTerms.id, { onDelete: 'cascade' }),
    learningRecordId: uuid('learning_record_id').references(() => learningRecords.id, { onDelete: 'cascade' }),
    due: timestamp('due', { withTimezone: true }).notNull(),
    stability: real('stability').notNull().default(0),
    difficulty: real('difficulty').notNull().default(0),
    elapsedDays: integer('elapsed_days').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    state: smallint('state').notNull().default(0),
    lastReview: timestamp('last_review', { withTimezone: true }),
  },
  (t) => [
    // Exactly one source: glossary term XOR learning record (spec §4 dual-FK rule).
    check(
      'review_cards_one_source',
      sql`(${t.glossaryTermId} IS NOT NULL) <> (${t.learningRecordId} IS NOT NULL)`
    ),
  ]
);

export const reviewLog = pgTable('review_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull().references(() => reviewCards.id, { onDelete: 'cascade' }),
  rating: smallint('rating').notNull(), // 1=Again 2=Hard 3=Good 4=Easy — deterministic mapping, never LLM-chosen
  state: smallint('state').notNull(),
  due: timestamp('due', { withTimezone: true }).notNull(),
  stability: real('stability').notNull(),
  difficulty: real('difficulty').notNull(),
  elapsedDays: integer('elapsed_days').notNull(),
  scheduledDays: integer('scheduled_days').notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Reserved for v1.x (spec §4: "schema reserved, not active in v1") ──────────
export const conceptAbility = pgTable('concept_ability', {
  id: uuid('id').primaryKey().defaultRandom(),
  learnerId: uuid('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  conceptKey: text('concept_key').notNull(), // skill-node name or glossary term key
  rating: real('rating').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const itemDifficulty = pgTable('item_difficulty', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemKey: text('item_key').notNull().unique(), // stable hash of generated quiz item
  difficulty: real('difficulty').notNull().default(0), // LLM-emitted prior, updated on attempts
  attempts: integer('attempts').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate + migrate**

```bash
npx drizzle-kit generate --name reviews
npx drizzle-kit migrate
```

- [ ] **Step 3: Write the failing test** — `src/test/reviews.test.ts`

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { testDb, resetDb } from './db';
import * as s from '@/db/schema';

describe('review cards', () => {
  let learnerId: string;
  let termId: string;
  let recordId: string;

  beforeAll(async () => {
    await resetDb();
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'R', email: 'review@t.dev' })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'R', ageBand: '18_plus' })
      .returning();
    learnerId = learner.id;
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId, topic: 'Photosynthesis', vertical: 'science' })
      .returning();
    const [record] = await testDb
      .insert(s.learningRecords)
      .values({
        trackId: track.id, seq: 1, recordType: 'demonstrated_understanding',
        title: 'Light reactions', body: 'Explained the light-dependent reactions correctly.',
      })
      .returning();
    recordId = record.id;
    const [term] = await testDb
      .insert(s.glossaryTerms)
      .values({
        trackId: track.id, term: 'chlorophyll', definition: 'The light-absorbing pigment in chloroplasts.',
        promotionEvidenceRecordId: record.id,
      })
      .returning();
    termId = term.id;
  });

  it('accepts a card with exactly one source', async () => {
    const [card] = await testDb
      .insert(s.reviewCards)
      .values({ learnerId, glossaryTermId: termId, due: new Date() })
      .returning();
    expect(card.state).toBe(0);
  });

  it('rejects a card with both sources (XOR check)', async () => {
    await expect(
      testDb.insert(s.reviewCards).values({
        learnerId, glossaryTermId: termId, learningRecordId: recordId, due: new Date(),
      })
    ).rejects.toThrow(/check constraint|review_cards_one_source/i);
  });

  it('rejects a card with no source (XOR check)', async () => {
    await expect(
      testDb.insert(s.reviewCards).values({ learnerId, due: new Date() })
    ).rejects.toThrow(/check constraint|review_cards_one_source/i);
  });
});
```

Run: `npm test` → Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: review schema (FSRS cards with XOR source, review log, reserved rating tables)"
```

---

### Task 9: Research schema (pgvector) + trust domains

Spec §4/§5: shared `topic_dossiers` cache with vector similarity lookup; versioned tiered allowlists + blocklist.

**Files:**
- Create: `src/db/schema/research.ts`, `drizzle/` custom migration enabling the extension
- Modify: `src/db/schema/index.ts` (add `export * from './research';`)
- Test: `src/test/research.test.ts`

- [ ] **Step 1: Create the extension migration first** (vector type needs the extension before the table)

```bash
npx drizzle-kit generate --custom --name enable-pgvector
```

Edit the generated empty SQL file in `drizzle/` to contain exactly:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 2: Create `src/db/schema/research.ts`**

```ts
import { pgTable, text, timestamp, jsonb, uuid, pgEnum, vector, index, uniqueIndex } from 'drizzle-orm/pg-core';
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
  (t) => [uniqueIndex('trust_domains_vertical_domain').on(t.vertical, t.domain)]
);
```

- [ ] **Step 3: Generate + migrate**

```bash
npx drizzle-kit generate --name research
npx drizzle-kit migrate
```

Expected: extension migration runs before the table migration (drizzle orders by file prefix — confirm the custom file sorts first; if not, rename its numeric prefix accordingly).

- [ ] **Step 4: Write the failing test** — `src/test/research.test.ts`

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { sql, cosineDistance, desc } from 'drizzle-orm';
import { testDb, resetDb } from './db';
import * as s from '@/db/schema';

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed * (i + 1)) );
}

describe('topic dossier cache', () => {
  beforeAll(resetDb);

  it('stores and retrieves by cosine similarity', async () => {
    const target = fakeEmbedding(1);
    await testDb.insert(s.topicDossiers).values([
      {
        vertical: 'science', topic: 'photosynthesis intro', levelBand: 'novice',
        embedding: target, ttlExpiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        vertical: 'science', topic: 'thermodynamics', levelBand: 'novice',
        embedding: fakeEmbedding(99), ttlExpiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const similarity = sql<number>`1 - (${cosineDistance(s.topicDossiers.embedding, target)})`;
    const [best] = await testDb
      .select({ topic: s.topicDossiers.topic, similarity })
      .from(s.topicDossiers)
      .orderBy(desc(similarity))
      .limit(1);
    expect(best.topic).toBe('photosynthesis intro');
    expect(best.similarity).toBeGreaterThan(0.99);
  });

  it('keeps one tier row per (vertical, domain)', async () => {
    await testDb.insert(s.trustDomains).values({ vertical: 'programming', domain: 'developer.mozilla.org', tier: 'tier1' });
    await expect(
      testDb.insert(s.trustDomains).values({ vertical: 'programming', domain: 'developer.mozilla.org', tier: 'tier2' })
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
```

Run: `npm test` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: research schema (pgvector topic dossiers, trust domains)"
```

---

### Task 10: Credit ledger (TDD)

Spec §4 billing: append-only ledger; 1 lesson = 1 credit (hold → capture/refund); free tier = 3 grants/month, no rollover, hardcoded; no Stripe.

Ledger semantics: `grant +3` · `hold −1` · `refund +1` (references the hold) · `capture ±0` (audit marker finalizing a hold). Balance = `SUM(amount)`.

**Files:**
- Create: `src/db/schema/billing.ts`, `src/lib/credits.ts`
- Modify: `src/db/schema/index.ts` (add `export * from './billing';`)
- Test: `src/lib/credits.test.ts`

- [ ] **Step 1: Create `src/db/schema/billing.ts`**

```ts
import { pgTable, text, timestamp, integer, uuid, pgEnum } from 'drizzle-orm/pg-core';
import { user } from './auth';

export const creditEntryType = pgEnum('credit_entry_type', ['purchase', 'grant', 'hold', 'capture', 'refund']);

export const creditLedger = pgTable('credit_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  entryType: creditEntryType('entry_type').notNull(),
  amount: integer('amount').notNull(), // grant +N, hold -1, refund +1, capture 0
  relatedEntryId: uuid('related_entry_id'), // capture/refund → the hold they settle
  lessonId: uuid('lesson_id'), // soft reference; lessons may be deleted independently
  stripeRef: text('stripe_ref'), // null until Phase 9 (Stripe)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate + migrate**

```bash
npx drizzle-kit generate --name billing
npx drizzle-kit migrate
```

- [ ] **Step 3: Write the failing tests** — `src/lib/credits.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, resetDb } from '@/test/db';
import * as s from '@/db/schema';
import { ensureMonthlyGrant, balance, placeHold, captureHold, refundHold, InsufficientCreditsError, FREE_MONTHLY_GRANT } from './credits';

async function seedUser() {
  const [u] = await testDb
    .insert(s.user)
    .values({ id: crypto.randomUUID(), name: 'C', email: `${crypto.randomUUID()}@t.dev` })
    .returning();
  return u.id;
}

describe('credit ledger', () => {
  beforeEach(resetDb);

  it('grants the free tier once per calendar month (idempotent)', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    await ensureMonthlyGrant(testDb, userId); // second call: no-op
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT);
  });

  it('hold → capture consumes one credit', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    const holdId = await placeHold(testDb, userId);
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT - 1);
    await captureHold(testDb, holdId);
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT - 1);
  });

  it('hold → refund restores the credit', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    const holdId = await placeHold(testDb, userId);
    await refundHold(testDb, holdId);
    expect(await balance(testDb, userId)).toBe(FREE_MONTHLY_GRANT);
  });

  it('rejects a hold at zero balance', async () => {
    const userId = await seedUser(); // no grant
    await expect(placeHold(testDb, userId)).rejects.toThrow(InsufficientCreditsError);
  });

  it('refunding twice is rejected', async () => {
    const userId = await seedUser();
    await ensureMonthlyGrant(testDb, userId);
    const holdId = await placeHold(testDb, userId);
    await refundHold(testDb, holdId);
    await expect(refundHold(testDb, holdId)).rejects.toThrow(/already settled/i);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test -- credits`
Expected: FAIL — `src/lib/credits.ts` does not exist.

- [ ] **Step 5: Implement `src/lib/credits.ts`**

```ts
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
      lessonId: hold.lessonId,
    });
  });
}

export const captureHold = (db: Db, holdId: string) => settleHold(db, holdId, 'capture');
export const refundHold = (db: Db, holdId: string) => settleHold(db, holdId, 'refund');
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- credits`
Expected: 5 passed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: append-only credit ledger with monthly free-tier grants (TDD)"
```

---

### Task 11: Design tokens + landing placeholder

Spec §11: light-first, sky palette + warm sun accent, two type weights, generous whitespace, reduced-motion honored globally.

**Files:**
- Modify: `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`

- [ ] **Step 1: Replace `src/app/globals.css`**

```css
@import "tailwindcss";

@theme {
  /* ── Clear blue skies ─────────────────────────────────────── */
  --color-sky-50: #f2f9ff;
  --color-sky-100: #e3f2fe;
  --color-sky-200: #bfe3fd;
  --color-sky-300: #8fcdfb;
  --color-sky-400: #54aef5;
  --color-sky-500: #2b8fe8;
  --color-sky-600: #1a71c6;
  --color-sky-700: #175aa0;
  --color-sky-800: #184c84;
  --color-sky-900: #19406d;

  /* Warm sun accent — wins, mastery, streak-free celebration */
  --color-sun-100: #fff3d6;
  --color-sun-300: #ffd98a;
  --color-sun-500: #f5b53f;
  --color-sun-700: #b97f14;

  /* Neutral ink on warm white */
  --color-cloud: #fdfdfc;
  --color-ink-900: #1d2733;
  --color-ink-600: #4a5868;
  --color-ink-400: #8a97a6;

  --font-sans: var(--font-figtree), ui-sans-serif, system-ui, sans-serif;

  --radius-md: 0.625rem;
  --radius-lg: 1rem;
  --radius-xl: 1.5rem;
}

html {
  background: var(--color-cloud);
  color: var(--color-ink-900);
}

/* Spec §6: reduced motion is a hard, global rule — not per-component opt-in. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 2: Replace `src/app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import { Figtree } from 'next/font/google';
import './globals.css';

const figtree = Figtree({ subsets: ['latin'], variable: '--font-figtree' });

export const metadata: Metadata = {
  title: 'LearnAnything',
  description: 'You can learn anything. One small, beautiful lesson at a time.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: Replace `src/app/page.tsx`** (placeholder hero proving the tokens — onboarding replaces it in Phase 2)

```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-sky-100 via-sky-50 to-cloud px-6">
      <h1 className="max-w-2xl text-center text-5xl font-medium tracking-tight text-ink-900">
        You can learn <span className="text-sky-600">anything</span>
      </h1>
      <p className="mt-6 max-w-md text-center text-lg text-ink-600">
        One small, beautiful lesson at a time — grounded in real sources, shaped around why you want to learn.
      </p>
      <div className="mt-10 rounded-xl bg-sun-100 px-4 py-2 text-sm text-sun-700">
        Phase 1 foundation — onboarding arrives in Phase 2
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Visual check**

Run: `npm run dev` → http://localhost:3000 shows the sky-gradient hero, Figtree type, sun-accent chip. Toggle OS reduced-motion and confirm no animation (nothing animates yet — the rule is in place for later phases).
Run: `npm run build` → Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: clear-blue-skies design tokens + landing placeholder"
```

---

### Task 12: CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg17
        env:
          POSTGRES_USER: learnanything
          POSTGRES_PASSWORD: learnanything
          POSTGRES_DB: learnanything_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U learnanything"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgres://learnanything:learnanything@localhost:5432/learnanything_test
      TEST_DATABASE_URL: postgres://learnanything:learnanything@localhost:5432/learnanything_test
      BETTER_AUTH_SECRET: ci-secret-ci-secret-ci-secret-ci
      BETTER_AUTH_URL: http://localhost:3000
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

- [ ] **Step 2: Run the suite locally one more time**

Run: `npm run lint && npm test && npm run build`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "ci: lint + tests (pgvector service) + build"
```

---

## Done criteria (Phase 1)

- `docker compose up -d && npm run dev` boots the app with the sky landing page.
- `npm test` passes: auth signup, one-mission-per-track, record supersession, glossary promotion gate, lesson + shared-slug constraints, FSRS-card XOR, pgvector similarity, full credit-ledger behavior.
- `drizzle/` contains the complete §4 schema as committed migrations (including reserved tables).
- CI green on push.
- Nothing in this phase calls an LLM, sends email, or touches Stripe — by design (spec §12).
