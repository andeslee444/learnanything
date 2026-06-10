/**
 * Eval harness for the lesson pipeline (Phase 4a, Task 7).
 *
 * Usage:
 *   npm run evals              — fake mode (AI_FAKE_LLM=1 forced); safe to run against dev DB
 *   npm run evals -- --live    — asks for --yes confirmation; runs real models (costs money)
 *   npm run evals -- --live --yes  — live mode confirmed; runs real models
 *
 * In fake mode all 10 cases produce identical fixture content (same fixture is served for every
 * AI_FAKE_LLM call). The harness asserts PIPELINE MECHANICS, not generation quality.
 *
 * Generation-quality judging arrives when live keys + LangSmith land.
 * LangSmith seam: see `judges: []` stub in the results schema below — each entry will be a
 * LangSmith evaluator result { name, score, comment }. Populate this in Phase 5+.
 *
 * CI note: DATABASE_URL is set to the test DB by the CI workflow env block. The evals step
 * runs AFTER migrations (npx drizzle-kit migrate) and the e2e step so the schema is current
 * and allowlist rows exist from the seed:trust run embedded in e2e setup.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as s from '../src/db/schema/index.js';
import { createLessonRow, stagePlan, stageResearch, stageGenerate } from '../src/server/lessons/pipeline.js';
import { lessonContentSchema } from '../src/server/lessons/blocks.js';
import { validateLessonContent } from '../src/server/lessons/validate.js';

// ── flags ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isLive = args.includes('--live');
const isYes = args.includes('--yes');

if (isLive && !isYes) {
  console.error(
    '\n[COST WARNING] --live mode calls real LLM models and will incur API charges.\n' +
    'Pass --yes to confirm: npm run evals -- --live --yes\n',
  );
  process.exit(1);
}

// Enforce fake mode unless --live is explicitly requested + confirmed.
if (!isLive) {
  process.env.AI_FAKE_LLM = '1';
} else {
  // In live mode, delete AI_FAKE_LLM to prevent an exported shell var from silently serving fixtures.
  delete process.env.AI_FAKE_LLM;
}

// ── cases ─────────────────────────────────────────────────────────────────────

interface EvalCase {
  id: string;
  vertical: string;
  topic: string;
  levelBand: 'novice' | 'developing' | 'competent';
}

function loadCases(): EvalCase[] {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const casesPath = join(__dirname, 'cases.json');
  const raw = readFileSync(casesPath, 'utf8');
  const parsed = JSON.parse(raw);

  // Minimal shape check: ensure it's an array and each item has required fields.
  if (!Array.isArray(parsed)) {
    throw new Error('cases.json must be an array');
  }
  for (const item of parsed) {
    if (!item.id || !item.vertical || !item.topic || !item.levelBand) {
      throw new Error(`Invalid case item (missing required field): ${JSON.stringify(item)}`);
    }
  }

  return parsed as EvalCase[];
}

// ── trust-domain seeds ────────────────────────────────────────────────────────
// Minimal allowlist: fixture pipeline uses sources from these domains (matching
// the fake 'vet-sources' fixture which trusts docs.python.org + MDN + realpython.com).
// history fixture sources use britannica.com + worldhistory.org.
// Insert via onConflictDoNothing — safe to call repeatedly.

const PROGRAMMING_DOMAINS = ['docs.python.org', 'developer.mozilla.org', 'realpython.com'];
const HISTORY_DOMAINS     = ['britannica.com', 'worldhistory.org', 'loc.gov'];

async function ensureAllowlist(db: ReturnType<typeof drizzle>) {
  const seeds = [
    ...PROGRAMMING_DOMAINS.map((domain) => ({ vertical: 'programming', domain, tier: 'tier1' as const, note: 'eval-harness seed' })),
    ...HISTORY_DOMAINS.map((domain)     => ({ vertical: 'history',     domain, tier: 'tier1' as const, note: 'eval-harness seed' })),
  ];
  await (db as ReturnType<typeof drizzle<typeof s>>)
    .insert(s.trustDomains)
    .values(seeds)
    .onConflictDoNothing();
}

// ── throwaway fixture builder ─────────────────────────────────────────────────

type Db = ReturnType<typeof drizzle<typeof s>>;

async function buildFixture(db: Db, c: EvalCase) {
  return await db.transaction(async (tx) => {
    // user
    const userId = crypto.randomUUID();
    const [user] = await tx.insert(s.user)
      .values({ id: userId, name: `eval-${c.id}`, email: `eval-${c.id}@eval.internal` })
      .returning();

    // learner
    const [learner] = await tx.insert(s.learners)
      .values({ userId: user.id, displayName: `eval-${c.id}`, ageBand: '18_plus' })
      .returning();

    // track
    const [track] = await tx.insert(s.tracks)
      .values({ learnerId: learner.id, topic: c.topic, vertical: c.vertical, expertiseBand: c.levelBand })
      .returning();

    // mission (required by hydrateTrackState)
    await tx.insert(s.missions).values({
      trackId: track.id,
      whyText: `Eval fixture for ${c.topic}`,
      successCriteria: [{ description: 'pass the eval' }],
      constraints: {},
      outOfScope: [],
    });

    // skill node (frontier must be non-empty for stagePlan to succeed)
    const [node] = await tx.insert(s.skillNodes)
      .values({ trackId: track.id, name: c.topic, summary: `Foundational skill: ${c.topic}`, missionRelevance: 0.9 })
      .returning();

    // learning record (required as promotionEvidenceRecordId for the glossary term below)
    const [record] = await tx.insert(s.learningRecords)
      .values({ trackId: track.id, seq: 1, recordType: 'prior_knowledge', title: 'Eval prior', body: 'Seeded for eval.', evidence: {} })
      .returning();

    // glossary term (so openerItems are present in delivered lesson)
    await tx.insert(s.glossaryTerms).values({
      trackId: track.id,
      term: 'eval-term',
      definition: 'A named container for a value.',
      promotionEvidenceRecordId: record.id,
    });

    return { userId: user.id, learnerId: learner.id, trackId: track.id, nodeId: node.id };
  });
}

async function cleanupFixture(db: Db, userId: string) {
  // Cascade: user → learner → track → mission/nodes/lessons (all cascade on user delete).
  await db.delete(s.user).where(eq(s.user.id, userId));
}

// ── per-case checks ───────────────────────────────────────────────────────────

interface CaseChecks {
  statusReady: boolean;
  contentParses: boolean;
  validationPasses: boolean;
  winCheck2to4Items: boolean;
  allCitationsResolve: boolean;
}

interface CaseResult {
  caseId: string;
  pass: boolean;
  checks: CaseChecks;
  durationMs: number;
  /**
   * LangSmith seam — populated in Phase 5+ when live keys + a LangSmith project are wired.
   * Each entry: { name: string; score: number; comment?: string }
   */
  judges: [];
}

// ── main ──────────────────────────────────────────────────────────────────────

async function runCase(db: Db, c: EvalCase): Promise<CaseResult> {
  const start = Date.now();
  const checks: CaseChecks = {
    statusReady: false,
    contentParses: false,
    validationPasses: false,
    winCheck2to4Items: false,
    allCitationsResolve: false,
  };

  let userId: string | null = null;

  try {
    const fixture = await buildFixture(db, c);
    userId = fixture.userId;

    // Create lesson row + run all three pipeline stages directly (no workflow).
    // NOTE: The pipeline's deliver/fail paths call captureHold/refundHold via findHoldId.
    // With NO hold placed, findHoldId returns null, so those are no-ops — verified in
    // pipeline.ts: `if (holdId) await captureHold(...)` / `if (holdId) await refundHold(...)`.
    // Evals deliberately skip credit placement.
    const lesson = await createLessonRow(db, fixture.trackId);

    await stagePlan(db, lesson.id);
    await stageResearch(db, lesson.id);
    await stageGenerate(db, lesson.id);

    // Re-read the lesson after the pipeline.
    const [delivered] = await db.select().from(s.lessons).where(eq(s.lessons.id, lesson.id));

    // Check 1: status ready
    checks.statusReady = delivered.status === 'ready';

    // Check 2: content parses against lessonContentSchema
    const contentParse = lessonContentSchema.safeParse(delivered.content);
    checks.contentParses = contentParse.success;

    if (contentParse.success) {
      const content = contentParse.data;

      // Check 3: validateLessonContent passes
      // Build dossierSourceUrls from the lesson's citations (set by deliver()).
      const citations = (delivered.citations ?? []) as Array<{ url: string }>;
      const dossierSourceUrls = citations.map((c) => c.url);
      const validation = validateLessonContent({ content, dossierSourceUrls });
      checks.validationPasses = validation.ok;

      // Check 4: win-check has 2–4 items
      const winItems = content.winCheck.items;
      checks.winCheck2to4Items = winItems.length >= 2 && winItems.length <= 4;

      // Check 5: every article block has ≥1 citation that resolves (subset of validation, but explicit)
      const known = new Set(dossierSourceUrls);
      checks.allCitationsResolve = content.blocks
        .filter((b) => b.type === 'article')
        .every((b) => b.type === 'article' && b.citationUrls.some((u) => known.has(u)));
    }
  } catch (err) {
    console.error(`[${c.id}] exception:`, err);
  } finally {
    if (userId) {
      try { await cleanupFixture(db, userId); } catch { /* ignore */ }
    }
  }

  const pass = Object.values(checks).every(Boolean);
  return { caseId: c.id, pass, checks, durationMs: Date.now() - start, judges: [] };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Set it in .env or the environment.');
    process.exit(1);
  }

  const cases = loadCases();

  console.log(`\nRunning ${cases.length} eval cases in ${isLive ? 'LIVE' : 'FAKE'} mode...\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  const db = drizzle(pool, { schema: s });

  // Ensure allowlist rows exist (idempotent; dev DB already has them from seed:trust).
  await ensureAllowlist(db);

  const results: CaseResult[] = [];
  let anyFailure = false;

  for (const c of cases) {
    const result = await runCase(db, c);
    results.push(result);
    if (!result.pass) anyFailure = true;
  }

  await pool.end();

  // ── console table ────────────────────────────────────────────────────────────
  const COL_ID   = 28;
  const COL_PASS = 8;
  const COL_DUR  = 10;

  const header = [
    'case'.padEnd(COL_ID),
    'pass'.padEnd(COL_PASS),
    'durationMs'.padEnd(COL_DUR),
    'failed checks',
  ].join(' | ');
  const divider = '-'.repeat(header.length);

  console.log(divider);
  console.log(header);
  console.log(divider);

  for (const r of results) {
    const failedChecks = Object.entries(r.checks)
      .filter(([, v]) => !v)
      .map(([k]) => k)
      .join(', ');
    const passStr = r.pass ? 'PASS' : 'FAIL';
    console.log([
      r.caseId.padEnd(COL_ID),
      passStr.padEnd(COL_PASS),
      String(r.durationMs).padEnd(COL_DUR),
      failedChecks || '—',
    ].join(' | '));
  }

  console.log(divider);
  const passCount = results.filter((r) => r.pass).length;
  console.log(`\nResult: ${passCount}/${results.length} passed\n`);

  // ── write results.json ───────────────────────────────────────────────────────
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = dirname(__filename);
  const outPath    = join(__dirname, 'results.json');

  const output = {
    generatedAt: new Date().toISOString(),
    mode: isLive ? 'live' : 'fake',
    cases: results,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  console.log(`Results written to evals/results.json`);

  if (anyFailure) {
    console.error('\nOne or more eval cases FAILED. See failed checks above.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
