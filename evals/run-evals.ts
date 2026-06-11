/**
 * Eval harness for the lesson pipeline (Phase 4a, Task 7).
 *
 * Usage:
 *   npm run evals              — fake mode (AI_FAKE_LLM=1 forced); safe to run against dev DB
 *   npm run evals -- --live    — asks for --yes confirmation; runs real models (costs money)
 *   npm run evals -- --live --yes  — live mode confirmed; runs real models
 *
 * In fake mode all 36 cases produce identical fixture content (same fixture is served for every
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
import { eq, sql } from 'drizzle-orm';
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as s from '../src/db/schema/index.js';
import { createLessonRow, stagePlan, stageResearch, stageGenerate } from '../src/server/lessons/pipeline.js';
import { lessonContentSchema } from '../src/server/lessons/blocks.js';
import { validateLessonContent } from '../src/server/lessons/validate.js';
import { stripContentAnswerKey } from '../src/app/api/lessons/[lessonId]/route.js';
import { distillLesson } from '../src/server/lessons/distiller.js';
import { verifyBlock } from '../src/server/lessons/verify.js';
import { pickArticleIndexes, computeFinalize, maybeAlertFaithfulness } from '../src/server/lessons/verdicts.js';

// ── flags ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isLive = args.includes('--live');
const isYes = args.includes('--yes');

// Compute a unique run ID at startup (base36 timestamp).
// This ensures emails and names are unique even if the script crashes and re-runs.
const RUN_ID = Date.now().toString(36);

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
  ageBand: '13_15' | '16_17' | '18_plus';
}

// Expected matrix dimensions
const EXPECTED_VERTICALS  = ['programming', 'history', 'math', 'science'] as const;
const EXPECTED_AGE_BANDS  = ['13_15', '16_17', '18_plus'] as const;
const EXPECTED_LEVEL_BANDS = ['novice', 'developing', 'competent'] as const;
const EXPECTED_CASE_COUNT = EXPECTED_VERTICALS.length * EXPECTED_AGE_BANDS.length * EXPECTED_LEVEL_BANDS.length; // 36

function assertMatrixComplete(cases: EvalCase[]): void {
  if (cases.length !== EXPECTED_CASE_COUNT) {
    throw new Error(
      `Matrix assertion failed: expected ${EXPECTED_CASE_COUNT} cases, got ${cases.length}`,
    );
  }
  for (const vertical of EXPECTED_VERTICALS) {
    for (const ageBand of EXPECTED_AGE_BANDS) {
      for (const levelBand of EXPECTED_LEVEL_BANDS) {
        const found = cases.some(
          (c) => c.vertical === vertical && c.ageBand === ageBand && c.levelBand === levelBand,
        );
        if (!found) {
          throw new Error(
            `Matrix assertion failed: missing cell vertical=${vertical} ageBand=${ageBand} levelBand=${levelBand}`,
          );
        }
      }
    }
  }
  // Check all ids are unique
  const ids = cases.map((c) => c.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    throw new Error(`Matrix assertion failed: duplicate case ids: ${dupes.join(', ')}`);
  }
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
    if (!item.id || !item.vertical || !item.topic || !item.levelBand || !item.ageBand) {
      throw new Error(`Invalid case item (missing required field): ${JSON.stringify(item)}`);
    }
  }

  const cases = parsed as EvalCase[];

  // Startup assertion: cases must form a complete distinct vertical×age×level matrix.
  assertMatrixComplete(cases);

  return cases;
}

// ── orphan sweep ─────────────────────────────────────────────────────────────
// Clean up any orphaned eval users from prior crashed runs. This ensures no
// unique email constraint collisions when fixture users are created.
// Deletes all users with email matching 'eval-*@eval.internal' pattern.

async function sweepOrphanFixtures(db: ReturnType<typeof drizzle>) {
  const result = await db.delete(s.user)
    .where(sql`${s.user.email} LIKE 'eval-%@eval.internal'`);
  // result is a Delete statement object; call it to execute
  return result;
}

// ── trust-domain seeds ────────────────────────────────────────────────────────
// Minimal allowlist: fixture pipeline uses sources from these domains (matching
// the fake 'vet-sources' fixture which trusts docs.python.org + MDN + realpython.com).
// history fixture sources use britannica.com + worldhistory.org.
// Insert via onConflictDoNothing — safe to call repeatedly.

const PROGRAMMING_DOMAINS = ['docs.python.org', 'developer.mozilla.org', 'realpython.com'];
const HISTORY_DOMAINS     = ['britannica.com', 'worldhistory.org', 'loc.gov'];
const MATH_DOMAINS        = [
  'khanacademy.org', 'mathworld.wolfram.com', 'artofproblemsolving.com', 'nctm.org', 'maa.org',
  'mathigon.org', 'brilliant.org', 'desmos.com', 'mathisfun.com', 'openstax.org',
  'ams.org', 'plus.maths.org', '3blue1brown.com', 'purplemath.com', 'cuemath.com',
];
const SCIENCE_DOMAINS     = [
  'nasa.gov', 'noaa.gov', 'nature.com', 'scientificamerican.com', 'nih.gov',
  'science.org', 'nationalgeographic.com', 'exploratorium.edu', 'sciencedaily.com', 'britannica.com',
  'hhmi.org', 'acs.org', 'aps.org', 'physics.org', 'chemguide.co.uk',
];

async function ensureAllowlist(db: ReturnType<typeof drizzle>) {
  const seeds = [
    ...PROGRAMMING_DOMAINS.map((domain) => ({ vertical: 'programming', domain, tier: 'tier1' as const, note: 'eval-harness seed' })),
    ...HISTORY_DOMAINS.map((domain)     => ({ vertical: 'history',     domain, tier: 'tier1' as const, note: 'eval-harness seed' })),
    ...MATH_DOMAINS.map((domain)        => ({ vertical: 'math',        domain, tier: 'tier1' as const, note: 'eval-harness seed' })),
    ...SCIENCE_DOMAINS.map((domain)     => ({ vertical: 'science',     domain, tier: 'tier1' as const, note: 'eval-harness seed' })),
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
    // user (email and name are scoped by RUN_ID to avoid collisions from prior crashed runs)
    const userId = crypto.randomUUID();
    const [user] = await tx.insert(s.user)
      .values({ id: userId, name: `eval-${c.id}-${RUN_ID}`, email: `eval-${c.id}-${RUN_ID}@eval.internal` })
      .returning();

    // learner — use the case's ageBand (parametrized; was hardcoded '18_plus' before Task 4)
    const [learner] = await tx.insert(s.learners)
      .values({ userId: user.id, displayName: `eval-${c.id}-${RUN_ID}`, ageBand: c.ageBand })
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

// ── answer-key scan helper ────────────────────────────────────────────────────
// Used by noAnswerKeyInGet check: deep-scans a serialized object for correctIndex/explanation.

function hasAnswerKey(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return (obj as unknown[]).some(hasAnswerKey);
  const record = obj as Record<string, unknown>;
  if ('correctIndex' in record || 'explanation' in record) return true;
  return Object.values(record).some(hasAnswerKey);
}

// ── per-case checks ───────────────────────────────────────────────────────────

interface CaseChecks {
  statusReady: boolean;
  contentParses: boolean;
  validationPasses: boolean;
  winCheck2to4Items: boolean;
  allCitationsResolve: boolean;
  hasFlashcards: boolean;
  hasWorkedExample: boolean;
  hasAnimatedDiagram: boolean;
  noAnswerKeyInGet: boolean;
  // Phase 5: distiller checks
  distillerProducesRecords: boolean;
  glossaryPromoted: boolean;
  referenceDocCreated: boolean;
  // Phase 6: verification checks
  lessonVerified: boolean;
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
    hasFlashcards: false,
    hasWorkedExample: false,
    hasAnimatedDiagram: false,
    noAnswerKeyInGet: false,
    distillerProducesRecords: false,
    glossaryPromoted: false,
    referenceDocCreated: false,
    lessonVerified: false,
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

      // Check 6: fixture delivers a flashcard_deck block (Phase 4b new block)
      checks.hasFlashcards = content.blocks.some((b) => b.type === 'flashcard_deck');

      // Check 7: fixture delivers a worked_example block (Phase 4b new block)
      checks.hasWorkedExample = content.blocks.some((b) => b.type === 'worked_example');

      // Check 8: fixture delivers an animated_diagram block (Phase 4b new block)
      checks.hasAnimatedDiagram = content.blocks.some((b) => b.type === 'animated_diagram');

      // Check 9: GET serialization strips correctIndex + explanation (no answer key in wire shape)
      // Simulate what the GET handler does — deep-clone and strip answer key fields.
      const wireContent = stripContentAnswerKey(delivered.content);
      checks.noAnswerKeyInGet = !hasAnswerKey(wireContent);

      // ── Phase 5: distiller checks ──────────────────────────────────────────
      // Seed two correct first-attempt win_check events for the win-check item ids
      // (the distiller reads first-attempt events for the lesson's win-check items).
      // The lesson was generated with fixture content — win-check items have ids 'wc1' and 'wc2'.
      // We insert the events here (after pipeline) to satisfy the distiller's evidence gate.
      try {
        if (delivered.status === 'ready') {
          // Insert first-attempt-correct events for both win-check items
          const winCheckItemIds = ['wc1', 'wc2'];
          for (const itemId of winCheckItemIds) {
            await db.insert(s.attemptEvents).values({
              learnerId: fixture.learnerId,
              lessonId: lesson.id,
              blockId: itemId,
              eventType: 'win_check',
              correct: true,
              payload: {},
            });
          }

          // Run the distiller directly (fake mode — no real LLM calls)
          const distillResult = await distillLesson(db, {
            lessonId: lesson.id,
            learnerId: fixture.learnerId,
          });

          // Check 10: distillerProducesRecords — at least one learning record inserted
          checks.distillerProducesRecords = distillResult.inserted && distillResult.recordIds.length > 0;

          // Check 11: glossaryPromoted — at least one glossary term promoted (fixture promotes 'variable')
          checks.glossaryPromoted = distillResult.promotedTermIds.length > 0;

          // Check 12: referenceDocCreated — a reference doc was created
          checks.referenceDocCreated = distillResult.referenceDocId !== null;
        }
      } catch (distillErr) {
        console.error(`[${c.id}] distiller check exception:`, distillErr);
        // Checks remain false
      }

      // ── Phase 6: lessonVerified check ─────────────────────────────────────
      // Run the verify sequence post-pipeline (seed → verifyBlock → finalize).
      // In fake mode: all claims return 'supported', so score = 1.0 and status = 'verified'.
      // Assert: faithfulnessScore >= 0.8 AND verificationStatus === 'verified'.
      try {
        if (delivered.status === 'ready') {
          const content = contentParse.data;

          // Step 1: Find article block indexes using shared pure helper
          const articleBlockIndexes = pickArticleIndexes(content.blocks);

          if (articleBlockIndexes.length > 0) {
            // Step 2: Seed 'checking' rows (ON CONFLICT DO NOTHING — idempotent)
            await db
              .insert(s.verificationResults)
              .values(
                articleBlockIndexes.map((i) => ({
                  lessonId: lesson.id,
                  blockId: `block-${i}`,
                  status: 'checking' as const,
                  claimsTotal: 0,
                  claimsVerified: 0,
                  details: [],
                })),
              )
              .onConflictDoNothing();

            // Step 3: Verify each article block directly (fake mode → all claims supported)
            for (const blockIndex of articleBlockIndexes) {
              await verifyBlock(db, { lessonId: lesson.id, blockIndex });
            }

            // Step 4: Finalize — compute score and update lesson using shared helpers
            const verifyRows = await db
              .select({
                claimsVerified: s.verificationResults.claimsVerified,
                claimsTotal: s.verificationResults.claimsTotal,
                status: s.verificationResults.status,
              })
              .from(s.verificationResults)
              .where(eq(s.verificationResults.lessonId, lesson.id));

            const { score, verificationStatus: verStatus } = computeFinalize(verifyRows);

            await db
              .update(s.lessons)
              .set({ faithfulnessScore: score, verificationStatus: verStatus })
              .where(eq(s.lessons.id, lesson.id));

            // Fire founder-alert via the shared function (greppable seam).
            maybeAlertFaithfulness(lesson.id, score);

            // Check 13: lessonVerified — faithfulnessScore >= 0.8 AND verificationStatus 'verified'
            checks.lessonVerified = score >= 0.8 && verStatus === 'verified';
          } else {
            // No article blocks to verify — vacuously passes (nothing to fail)
            checks.lessonVerified = true;
          }
        }
      } catch (verifyErr) {
        console.error(`[${c.id}] lessonVerified check exception:`, verifyErr);
        // Check remains false
      }
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

  // Sweep orphaned eval users from prior crashed runs (prevents email collision)
  await sweepOrphanFixtures(db);

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
