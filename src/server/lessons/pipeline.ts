import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';
import { MODEL_TIERS } from '@/lib/ai';
import type { AgeBand } from '@/lib/age-band';
import { captureHold, refundHold } from '@/lib/credits';
import { moderateText } from '@/server/moderation';
import { researchTopic } from '@/server/research/research-topic';
import { db as appDb } from '@/lib/db';
import { lessonPlanSchema, winCheckPassed, type LessonContent } from './blocks';
import { buildOpenerItems, hydrateTrackState, pickFrontierNode, planLesson } from './planner';
import { generateBlocks } from './generate';
import { validateLessonContent } from './validate';
import { start } from 'workflow/api';
import { verifyLessonWorkflow } from '@/workflows/verify-lesson';
import { sendEmail, sanitizeSubjectPart } from '@/lib/email';

type Db = NodePgDatabase<typeof s>;

/** Same FOR UPDATE convention as learning_records / lessons seq backstopped by the unique index. */
async function nextLessonSeq(tx: Parameters<Parameters<Db['transaction']>[0]>[0], trackId: string) {
  await tx.execute(sql`SELECT id FROM tracks WHERE id = ${trackId} FOR UPDATE`);
  const [row] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${s.lessons.seq}), 0)::int` })
    .from(s.lessons)
    .where(eq(s.lessons.trackId, trackId));
  return row.max + 1;
}

export async function createLessonRow(db: Db, trackId: string) {
  return db.transaction(async (tx) => {
    const seq = await nextLessonSeq(tx, trackId);
    const [lesson] = await tx
      .insert(s.lessons)
      .values({ trackId, seq, spec: {}, status: 'generating' })
      .returning();
    return lesson;
  });
}

async function findHoldId(db: Db, lessonId: string): Promise<string | null> {
  const [hold] = await db
    .select({ id: s.creditLedger.id })
    .from(s.creditLedger)
    .where(and(eq(s.creditLedger.lessonId, lessonId), eq(s.creditLedger.entryType, 'hold')))
    .orderBy(desc(s.creditLedger.createdAt))
    .limit(1);
  return hold?.id ?? null;
}

async function failLesson(db: Db, lessonId: string, reason: string) {
  // C2: CAS — only transition from 'generating'; if someone else already terminal'd it, skip side-effects.
  const rows = await db
    .update(s.lessons)
    .set({ status: 'failed', content: { failureReason: reason } })
    .where(and(eq(s.lessons.id, lessonId), eq(s.lessons.status, 'generating')))
    .returning({ id: s.lessons.id });
  if (rows.length === 0) return { status: 'failed' as const, reason };
  const holdId = await findHoldId(db, lessonId);
  if (holdId) await refundHold(db, holdId).catch((err) => console.error('refund failed', err));
  return { status: 'failed' as const, reason };
}

/**
 * Safe public wrapper: marks the lesson failed and refunds.
 * Call from route start-catch handlers — swallows errors so a secondary failure
 * never masks the original error.
 */
export async function failLessonSafely(db: Db, lessonId: string, reason: string) {
  try {
    await failLesson(db, lessonId, reason);
  } catch (err) {
    console.error('failLessonSafely secondary error', err);
  }
}

/** Stage 1 (spec §2 step 1): plan from track state. */
export async function stagePlan(db: Db, lessonId: string) {
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson || lesson.status !== 'generating') return { status: 'skipped' as const };
  const state = await hydrateTrackState(db, lesson.trackId);
  if (!state) return failLesson(db, lessonId, 'track state missing');
  const node = pickFrontierNode(state);
  if (!node) return failLesson(db, lessonId, 'no frontier skill to teach (map complete)');
  const plan = await planLesson(state, node);
  const planPatch = { nodeId: node.id, nodeName: node.name, expertiseBand: state.track.expertiseBand };
  await db
    .update(s.lessons)
    .set({
      spec: plan,
      zpdSnapshot: sql`zpd_snapshot || ${JSON.stringify(planPatch)}::jsonb`,
      modelVersion: MODEL_TIERS.planner,
    })
    .where(eq(s.lessons.id, lessonId));
  return { status: 'planned' as const };
}

/** Stage 2 (spec §2 step 2): dossier via the Phase 3 research layer. */
export async function stageResearch(db: Db, lessonId: string) {
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson || lesson.status !== 'generating') return { status: 'skipped' as const };
  // Join learner to get ageBand for age-banded moderation.
  const [trackRow] = await db
    .select({ track: s.tracks, ageBand: s.learners.ageBand })
    .from(s.tracks)
    .innerJoin(s.learners, eq(s.tracks.learnerId, s.learners.id))
    .where(eq(s.tracks.id, lesson.trackId));
  if (!trackRow) return failLesson(db, lessonId, 'track or learner missing');
  const { track, ageBand } = trackRow;
  const snapshot = lesson.zpdSnapshot as { nodeName?: string };
  const topic = `${track.topic}: ${snapshot.nodeName ?? track.topic}`;
  const result = await researchTopic(db, { vertical: track.vertical, topic, levelBand: track.expertiseBand }, { ageBand: ageBand as AgeBand });
  if (result.status === 'insufficient_sources') {
    return failLesson(db, lessonId, 'not enough trustworthy sources for this topic yet');
  }
  if (result.status === 'blocked') {
    return failLesson(db, lessonId, result.retryable ? 'research temporarily unavailable — try again' : 'topic declined');
  }
  await db
    .update(s.lessons)
    .set({
      zpdSnapshot: sql`zpd_snapshot || ${JSON.stringify({ dossierId: result.dossierId })}::jsonb`,
    })
    .where(eq(s.lessons.id, lessonId));
  return { status: 'researched' as const };
}

/** Stage 3 (spec §2 steps 3-5): generate, validate, moderate, deliver, capture. */
export async function stageGenerate(db: Db, lessonId: string) {
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson || lesson.status !== 'generating') return { status: 'skipped' as const };

  // Join track → learner to hydrate the learner's ageBand for readability gating.
  const [trackRow] = await db
    .select({ track: s.tracks, ageBand: s.learners.ageBand })
    .from(s.tracks)
    .innerJoin(s.learners, eq(s.tracks.learnerId, s.learners.id))
    .where(eq(s.tracks.id, lesson.trackId));
  if (!trackRow) return failLesson(db, lessonId, 'track or learner missing');
  const { track, ageBand } = trackRow;

  const snapshot = lesson.zpdSnapshot as { dossierId?: string };
  if (!snapshot?.dossierId) return failLesson(db, lessonId, 'dossier reference missing');
  const [dossier] = await db.select().from(s.topicDossiers).where(eq(s.topicDossiers.id, snapshot.dossierId));
  if (!dossier) return failLesson(db, lessonId, 'dossier missing');

  // IMPLEMENTER NOTE 1: parse lesson.spec with lessonPlanSchema; fail the lesson on parse error.
  const specParse = lessonPlanSchema.safeParse(lesson.spec);
  if (!specParse.success) {
    return failLesson(db, lessonId, `lesson spec invalid: ${specParse.error.issues.map((i) => i.message).join('; ')}`);
  }
  const plan = specParse.data;

  // Hydrate glossary aliases from the track state for the alias scan.
  const trackState = await hydrateTrackState(db, lesson.trackId);
  const glossaryAvoidAliases = (trackState?.glossary ?? []).flatMap((g) =>
    g.avoidAliases?.length ? [{ term: g.term, aliases: g.avoidAliases }] : [],
  );

  const dossierInput = {
    sources: dossier.sources,
    claims: dossier.claims,
    misconceptions: dossier.misconceptions,
  };
  const levelBand = track.expertiseBand as 'novice' | 'developing' | 'competent';

  const generated = await generateBlocks(plan, dossierInput, levelBand);
  const validatorInput = {
    content: generated,
    dossierSourceUrls: dossier.sources.map((src) => src.url),
    ageBand,
    glossaryAvoidAliases,
  };
  const check = validateLessonContent(validatorInput);
  if (!check.ok) {
    // IMPLEMENTER NOTE 2: thread validator errors (including readability) into the retry.
    const correction = check.errors.join('; ');
    const retry = await generateBlocks(plan, dossierInput, levelBand, correction);
    const recheck = validateLessonContent({ ...validatorInput, content: retry });
    if (!recheck.ok) return failLesson(db, lessonId, `lesson failed validation: ${recheck.errors.join('; ')}`);
    return deliver(db, lessonId, retry, dossier.sources, trackState, ageBand as AgeBand);
  }
  return deliver(db, lessonId, generated, dossier.sources, trackState, ageBand as AgeBand);
}

/**
 * Send a lesson-ready email to the learner who owns the lesson.
 * Exported for testability.
 *
 * Content discipline: subject contains objective (≤80 chars), text contains
 * only the lesson path (/tracks/{trackId}/lessons/{lessonId}) — no lesson body.
 * Caller is responsible for fire-and-forget + error suppression.
 */
export async function sendLessonReadyEmail(db: Db, lessonId: string): Promise<void> {
  // Join lesson → track → learner → user to get the learner's email.
  const [row] = await db
    .select({
      userEmail: s.user.email,
      trackId: s.tracks.id,
      objective: s.lessons.spec,
    })
    .from(s.lessons)
    .innerJoin(s.tracks, eq(s.lessons.trackId, s.tracks.id))
    .innerJoin(s.learners, eq(s.tracks.learnerId, s.learners.id))
    .innerJoin(s.user, eq(s.learners.userId, s.user.id))
    .where(eq(s.lessons.id, lessonId));
  if (!row) return;
  // Extract objective from spec — truncate to 80 chars.
  const specObj = row.objective as { objective?: string };
  const rawObjective = typeof specObj?.objective === 'string' ? specObj.objective : '';
  const objective = sanitizeSubjectPart(rawObjective.slice(0, 80));
  const subject = objective ? `Your lesson is ready: ${objective}` : 'Your lesson is ready';
  const lessonPath = `/tracks/${row.trackId}/lessons/${lessonId}`;
  await sendEmail({
    to: row.userEmail,
    subject,
    // Text contains only the lesson path — no lesson content (content discipline).
    text: `Your lesson is ready. Open it here: ${lessonPath}`,
  });
}

async function deliver(
  db: Db,
  lessonId: string,
  content: Omit<LessonContent, 'openerItems'>,
  sources: Array<{ url: string }>,
  trackState?: Awaited<ReturnType<typeof hydrateTrackState>>,
  ageBand?: AgeBand,
) {
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  const state = trackState ?? (await hydrateTrackState(db, lesson.trackId));
  const openerItems = buildOpenerItems(state?.glossary ?? []);
  const moderation = await moderateText(JSON.stringify(content), 'assembled_lesson', { ageBand });
  if (!moderation.allowed) {
    return failLesson(
      db,
      lessonId,
      moderation.errored ? 'safety check unavailable — try again' : 'lesson failed the safety check',
    );
  }
  // C2: CAS — only transition from 'generating'; if someone else already terminal'd it, skip capture.
  const rows = await db
    .update(s.lessons)
    .set({
      content: { ...content, openerItems },
      status: 'ready',
      citations: sources.map((src) => ({ url: src.url })),
      modelVersion: MODEL_TIERS.generator,
    })
    .where(and(eq(s.lessons.id, lessonId), eq(s.lessons.status, 'generating')))
    .returning({ id: s.lessons.id });
  if (rows.length === 0) return { status: 'skipped' as const };

  // Fire-and-forget lesson-ready email to the learner.
  // A failed email must never fail delivery.
  sendLessonReadyEmail(db, lessonId).catch(() => {});

  const holdId = await findHoldId(db, lessonId);
  if (holdId) await captureHold(db, holdId).catch((err: unknown) => {
    // Admin retries reuse the old refunded hold (findHoldId finds the most-recent hold entry).
    // captureHold on an already-settled/refunded hold throws "already settled" — this is
    // expected and not an error. Log debug to avoid noisy false-positive alerts in CI/prod.
    if (err instanceof Error && err.message.includes('already settled')) {
      console.debug('[capture] hold already settled — admin retry, skipping capture');
      return;
    }
    console.error('capture failed', err);
  });
  // Fire-and-forget: start the async verification workflow after capture.
  // The lesson is already usable (status='ready') — verification happens asynchronously.
  start(verifyLessonWorkflow, [lessonId]).catch((err: unknown) => {
    // WorkflowRuntimeError is expected outside the WDK runtime (e.g. tests, evals).
    // Log a single quiet line instead of a full error trace in those contexts.
    const isWdkError =
      err instanceof Error &&
      (err.name === 'WorkflowRuntimeError' || err.message.includes('WorkflowRuntimeError'));
    if (isWdkError) {
      console.warn('[verify] workflow unavailable outside WDK runtime');
    } else {
      console.error('verifyLessonWorkflow start failed', err);
    }
  });
  return { status: 'ready' as const };
}

/** Entry point the workflow steps call (each stage by id — serializable args only). */
export async function runLessonStage(stage: 'plan' | 'research' | 'generate' | 'fail', lessonId: string, message?: string) {
  if (stage === 'plan') return stagePlan(appDb, lessonId);
  if (stage === 'research') return stageResearch(appDb, lessonId);
  if (stage === 'fail') return failLesson(appDb, lessonId, message ?? 'generation error — try again');
  return stageGenerate(appDb, lessonId);
}

/**
 * Sweep lessons stuck in 'generating' that are older than `olderThanMs` ms.
 * Uses CAS (WHERE status = 'generating') via failLesson so a concurrent delivery
 * that wins the race is safe.
 *
 * `olderThanMs` is injectable so tests can pass a negative value (cutoff in the
 * future) to qualify freshly-created rows without manipulating the DB clock.
 * (0 is racy: a row's updated_at = Postgres now() can be >= a cutoff computed
 * from JS Date.now() in the same millisecond.)
 * Production callers use the default of 15 minutes.
 */
export async function sweepStaleLessons(
  db: Db,
  trackId: string,
  olderThanMs = 15 * 60 * 1000,
): Promise<{ swept: number }> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stale = await db
    .select({ id: s.lessons.id })
    .from(s.lessons)
    .where(
      and(
        eq(s.lessons.trackId, trackId),
        eq(s.lessons.status, 'generating'),
        lt(s.lessons.updatedAt, cutoff),
      ),
    );
  let swept = 0;
  for (const { id } of stale) {
    const result = await failLesson(db, id, 'generation timed out — please try again');
    if (result.status === 'failed') swept++;
  }
  return { swept };
}

/** Immediate UX cache only — the distiller (Phase 5) is the evidence authority for mastery; this write keeps the map snappy. */
export async function recordWinCheckResult(db: Db, lessonId: string, correct: number, total: number) {
  if (!winCheckPassed(correct, total)) return { passed: false };
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  const snapshot = lesson?.zpdSnapshot as { nodeId?: string };
  if (snapshot?.nodeId) {
    await db
      .update(s.skillNodes)
      .set({ mastery: 'demonstrated' })
      .where(and(eq(s.skillNodes.id, snapshot.nodeId), eq(s.skillNodes.trackId, lesson.trackId)));
  }
  return { passed: true };
}
