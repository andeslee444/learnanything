/**
 * verify-lesson workflow — Phase 6.
 *
 * Workflow steps (sandboxed — each 'use step' is one LLM-safe unit):
 *   1. seed        — insert 'checking' rows for every article block (ON CONFLICT DO NOTHING).
 *                    Returns the array of article block indexes so the loop below
 *                    can iterate over a serializable list (not DB state).
 *   2. verifyBlock — one step per article block index (returned from seed).
 *   3. finalize    — compute faithfulness, update lessons.faithfulnessScore +
 *                    verificationStatus; fire founder-alert under 0.8.
 *
 * Triggered fire-and-forget from pipeline.deliver after capture.
 * Errors are logged but do not propagate to the HTTP response.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { verifyBlock } from '@/server/lessons/verify';
import { pickArticleIndexes, computeFinalize, maybeAlertFaithfulness } from '@/server/lessons/verdicts';

// ── seed step ─────────────────────────────────────────────────────────────────

/**
 * Insert 'checking' rows for every article block in the lesson.
 * Uses ON CONFLICT DO NOTHING for idempotent re-entry.
 *
 * Returns the array of article block indexes (0-based) as a serializable list.
 * The workflow loops over this list to call verifyBlockStep per index.
 */
async function seed(lessonId: string): Promise<{ articleBlockIndexes: number[] }> {
  'use step';

  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, lessonId));
  if (!lesson || lesson.status !== 'ready') return { articleBlockIndexes: [] };

  const content = lesson.content as {
    blocks?: Array<{ type: string }>;
  } | null;
  if (!content?.blocks) return { articleBlockIndexes: [] };

  const articleIndexes = pickArticleIndexes(content.blocks);

  if (articleIndexes.length === 0) return { articleBlockIndexes: [] };

  // Insert 'checking' rows for each article block (ON CONFLICT DO NOTHING — idempotent)
  await db
    .insert(s.verificationResults)
    .values(
      articleIndexes.map((i) => ({
        lessonId,
        blockId: `block-${i}`,
        status: 'checking' as const,
        claimsTotal: 0,
        claimsVerified: 0,
        details: [],
      })),
    )
    .onConflictDoNothing();

  return { articleBlockIndexes: articleIndexes };
}

// ── per-block verify step ─────────────────────────────────────────────────────

async function verifyBlockStep(lessonId: string, blockIndex: number): Promise<void> {
  'use step';
  await verifyBlock(db, { lessonId, blockIndex });
}

// ── finalize step ─────────────────────────────────────────────────────────────

/**
 * Compute faithfulness from the verification_results rows.
 * Update lessons.faithfulnessScore + lessons.verificationStatus.
 * Fire founder-alert console.warn under ALERT_THRESHOLD (greppable seam).
 */
async function finalize(lessonId: string): Promise<void> {
  'use step';

  const rows = await db
    .select({
      claimsVerified: s.verificationResults.claimsVerified,
      claimsTotal: s.verificationResults.claimsTotal,
      status: s.verificationResults.status,
    })
    .from(s.verificationResults)
    .where(eq(s.verificationResults.lessonId, lessonId));

  if (rows.length === 0) return;

  const { score, verificationStatus } = computeFinalize(rows);

  await db
    .update(s.lessons)
    .set({
      faithfulnessScore: score,
      verificationStatus,
    })
    .where(eq(s.lessons.id, lessonId));

  // Founder-alert seam: greppable console.warn fires under 0.8 threshold.
  maybeAlertFaithfulness(lessonId, score);
}

// ── workflow ──────────────────────────────────────────────────────────────────

export async function verifyLessonWorkflow(lessonId: string): Promise<void> {
  'use workflow';

  // Step 1: Seed 'checking' rows; get back the serializable list of article block indexes.
  const { articleBlockIndexes } = await seed(lessonId);

  // Step 2: Verify each article block (per-block step — the count is known at workflow time
  // from the seed return value, so we can loop over the serializable list).
  for (const blockIndex of articleBlockIndexes) {
    await verifyBlockStep(lessonId, blockIndex);
  }

  // Step 3: Finalize — compute score, update lesson, fire alert if needed.
  await finalize(lessonId);
}
