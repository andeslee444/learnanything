/**
 * Distiller — Phase 5b core.
 *
 * distillLesson converts win-check evidence into learning_records, glossary
 * promotions, FSRS review cards, and a node mastery update.
 *
 * Admission gate (code + prompt):
 *   Coverage is not learning — record only what the EVIDENCE shows the learner
 *   can DO. 1-3 sentences per record. Records are decision-grade insights, not a
 *   session journal. When in doubt, record NOTHING.
 *
 * Idempotency: if a learning_record with evidence.lessonId == lessonId already
 * exists (jsonb containment), this function is a no-op.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import * as s from '@/db/schema';
import { llmObject } from '@/lib/ai';
import { createCardForGlossaryTerm } from '@/lib/reviews';
import { nextRecordSeq } from '@/server/tracks';

// Ref doc type enum values must match the DB pgEnum 'ref_doc_type'.
const REF_DOC_TYPES = [
  'cheat_sheet',
  'algorithm_flowchart',
  'syntax_reference',
  'routine',
  'sequence',
  'glossary_export',
] as const;

type Db = NodePgDatabase<typeof s>;
// Extract the transaction type from Drizzle's generic
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// ── Output schema ─────────────────────────────────────────────────────────────

export const distillRecordSchema = z.object({
  recordType: z.enum(['demonstrated_understanding', 'corrected_misconception']),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(400),
  implications: z.string().max(300).optional(),
});

export const distillOutputSchema = z.object({
  records: z.array(distillRecordSchema).min(0).max(4),
  glossaryPromotions: z.array(
    z.object({
      term: z.string().min(1).max(80),
      definition: z.string().min(1).max(300),
    }),
  ).min(0).max(4),
});

export type DistillOutput = z.infer<typeof distillOutputSchema>;

// ── Reference-doc output schema ───────────────────────────────────────────────

export const createReferenceDocSchema = z.object({
  title: z.string().min(1).max(120),
  docType: z.enum(REF_DOC_TYPES),
  sections: z.array(
    z.object({
      heading: z.string().min(1).max(80),
      markdown: z.string().min(1).max(2000),
    }),
  ).min(1).max(6),
});

export type CreateReferenceDocOutput = z.infer<typeof createReferenceDocSchema>;

// ── Reference-doc prompt ──────────────────────────────────────────────────────

const REFERENCE_DOC_SYSTEM_PROMPT = `You are a curriculum author generating a concise reference document for a learner's library.

Create a cheat sheet or quick reference that distills the key concepts from the lesson into a reusable, printable format.

Guidelines:
- Choose docType from: cheat_sheet, algorithm_flowchart, syntax_reference, routine, sequence, glossary_export
- Include 1-6 sections, each with a clear heading and markdown content (≤2000 chars each)
- Be concrete: code examples, tables, and bullet lists are better than prose
- Optimise for quick retrieval, not explanation — the learner already understands the material

Your response MUST be valid JSON matching this shape:
{
  "title": "string ≤120 chars",
  "docType": "cheat_sheet" | "algorithm_flowchart" | "syntax_reference" | "routine" | "sequence" | "glossary_export",
  "sections": [  // 1-6 items
    {
      "heading": "string ≤80 chars",
      "markdown": "string ≤2000 chars — use markdown freely (code blocks, tables, bullets)"
    }
  ]
}`;

function buildReferenceDocPrompt(opts: {
  objective: string;
  records: Array<{ title: string; body: string }>;
  promotions: Array<{ term: string; definition: string }>;
}): string {
  const lines: string[] = [
    `Lesson objective: ${opts.objective}`,
    '',
    'Learning records from this lesson:',
  ];
  for (const rec of opts.records) {
    lines.push(`  - ${rec.title}: ${rec.body}`);
  }
  if (opts.promotions.length > 0) {
    lines.push('', 'Glossary terms introduced:');
    for (const p of opts.promotions) {
      lines.push(`  - ${p.term}: ${p.definition}`);
    }
  }
  return lines.join('\n');
}

// ── Prompt construction ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an evidence-gated learning-record distiller.

Admission rubric (follow exactly):
Coverage is not learning — record only what the EVIDENCE shows the learner can DO. 1-3 sentences per record. Records are decision-grade insights, not a session journal. When in doubt, record NOTHING.

You receive:
- The lesson objective
- A per-item evidence summary showing which win-check items this learner answered correctly on their FIRST attempt
- Existing active record titles (avoid duplicating them)
- The track's current glossary terms (do not re-promote terms already present)

Your response MUST be valid JSON matching this shape:
{
  "records": [ // 0-4 items
    {
      "recordType": "demonstrated_understanding" | "corrected_misconception",
      "title": "string ≤120 chars",
      "body": "string ≤400 chars — 1-3 sentences summarising the observable EVIDENCE",
      "implications": "string ≤300 chars (optional)"
    }
  ],
  "glossaryPromotions": [ // 0-4 items
    {
      "term": "string ≤80 chars",
      "definition": "string ≤300 chars"
    }
  ]
}

Only promote a glossary term if the EVIDENCE shows the learner can reason about it. Do not re-promote existing terms.`;

function buildPrompt(opts: {
  objective: string;
  evidenceSummary: Array<{ itemId: string; question: string; firstAttemptCorrect: boolean }>;
  existingTitles: string[];
  existingGlossaryTerms: string[];
}): string {
  const correctCount = opts.evidenceSummary.filter((e) => e.firstAttemptCorrect).length;
  const totalCount = opts.evidenceSummary.length;

  const lines: string[] = [
    `Lesson objective: ${opts.objective}`,
    '',
    `Win-check evidence (${correctCount}/${totalCount} correct on first attempt):`,
  ];

  for (const item of opts.evidenceSummary) {
    lines.push(`  - [${item.firstAttemptCorrect ? 'CORRECT' : 'INCORRECT'}] ${item.question}`);
  }

  if (opts.existingTitles.length > 0) {
    lines.push('', 'Existing active record titles (do not duplicate):');
    for (const title of opts.existingTitles) {
      lines.push(`  - ${title}`);
    }
  }

  if (opts.existingGlossaryTerms.length > 0) {
    lines.push('', 'Existing glossary terms (do not re-promote):');
    for (const term of opts.existingGlossaryTerms) {
      lines.push(`  - ${term}`);
    }
  }

  return lines.join('\n');
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface DistillResult {
  /** Did actual work (records/promotions inserted). */
  inserted: boolean;
  /** Skipped due to idempotency guard. */
  skipped: boolean;
  recordIds: string[];
  promotedTermIds: string[];
  cardIds: string[];
  /** Reference doc id (upserted in step 7), null if skipped or none generated. */
  referenceDocId: string | null;
}

/**
 * Distills a passed win-check lesson into learning records, glossary
 * promotions, and FSRS review cards.
 *
 * All seven behaviors per spec:
 * 1. Load lesson (must be ready) + attempt events + glossary + records.
 * 2. Admission gate (LLM prompt + code-side dedup).
 * 3. Insert records via nextRecordSeq (FOR UPDATE convention).
 * 4. Promotions: insert glossary_terms with FK to first record id;
 *    umbrella record created if LLM returned promotions but zero records.
 * 5. createCardForGlossaryTerm for each promotion (FSRS bridge).
 * 6. Node mastery 'demonstrated' if ≥1 demonstrated_understanding record.
 * 7. Idempotent: no-op if evidence.lessonId already exists.
 */
export async function distillLesson(
  db: Db,
  opts: {
    lessonId: string;
    learnerId: string;
    /** Override the LLM model (for testing with MockLanguageModelV3). */
    modelOverride?: Parameters<typeof llmObject>[0]['modelOverride'];
  },
): Promise<DistillResult> {
  // ── Step 7 (idempotency check first) ─────────────────────────────────────
  const [idempotencyCheck] = await db
    .select({ id: s.learningRecords.id })
    .from(s.learningRecords)
    .innerJoin(s.tracks, eq(s.learningRecords.trackId, s.tracks.id))
    .where(
      and(
        eq(s.tracks.learnerId, opts.learnerId),
        sql`${s.learningRecords.evidence} @> ${JSON.stringify({ lessonId: opts.lessonId })}::jsonb`,
      ),
    )
    .limit(1);

  if (idempotencyCheck) {
    return { inserted: false, skipped: true, recordIds: [], promotedTermIds: [], cardIds: [], referenceDocId: null };
  }

  // ── Step 1: Load lesson ────────────────────────────────────────────────────
  const [lesson] = await db.select().from(s.lessons).where(eq(s.lessons.id, opts.lessonId));
  if (!lesson) {
    throw new Error('lesson not found', { cause: { lessonId: opts.lessonId } });
  }
  if (lesson.status !== 'ready') {
    throw new Error('lesson not ready for distillation', { cause: { lessonId: opts.lessonId, status: lesson.status } });
  }

  const { trackId } = lesson;
  const spec = lesson.spec as { objective?: string };
  const objective = spec.objective ?? 'Complete the lesson';

  // Ownership check
  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, trackId));
  if (!track || track.learnerId !== opts.learnerId) {
    throw new Error('lesson not owned by learner', { cause: { lessonId: opts.lessonId } });
  }

  // ── Step 1b: First-attempt-only evidence summary ──────────────────────────
  // We need the win-check items to get their questions.
  const content = lesson.content as {
    winCheck?: { items?: Array<{ id: string; question: string }> };
  } | null;
  const winCheckItems = content?.winCheck?.items ?? [];

  // Fetch win_check attempt events for this learner+lesson.
  const attemptRows = await db
    .select({
      id: s.attemptEvents.id,
      blockId: s.attemptEvents.blockId,
      correct: s.attemptEvents.correct,
      createdAt: s.attemptEvents.createdAt,
    })
    .from(s.attemptEvents)
    .where(
      and(
        eq(s.attemptEvents.learnerId, opts.learnerId),
        eq(s.attemptEvents.lessonId, opts.lessonId),
        eq(s.attemptEvents.eventType, 'win_check'),
      ),
    );

  // Group rows by itemId and find the earliest (first attempt) per item.
  // The id tiebreaker (used in the route's DISTINCT ON) is not needed here
  // because we do an in-process scan and order by createdAt.
  const byItem = new Map<string, { id: string; correct: boolean | null; createdAt: Date }>();
  for (const row of attemptRows) {
    if (!row.blockId) continue;
    const existing = byItem.get(row.blockId);
    if (!existing || row.createdAt < existing.createdAt) {
      byItem.set(row.blockId, { id: row.id, correct: row.correct, createdAt: row.createdAt });
    }
  }

  // Collect the win_check event ids actually used as evidence (first attempt per item).
  const attemptEventIds: string[] = Array.from(byItem.values()).map((v) => v.id);

  // Build evidence summary
  const evidenceSummary = winCheckItems.map((item) => {
    const firstAttempt = byItem.get(item.id);
    return {
      itemId: item.id,
      question: item.question,
      firstAttemptCorrect: firstAttempt?.correct === true,
    };
  });

  // ── Step 1c: Existing records + glossary ─────────────────────────────────
  const existingRecords = await db
    .select({ title: s.learningRecords.title })
    .from(s.learningRecords)
    .where(
      and(
        eq(s.learningRecords.trackId, trackId),
        eq(s.learningRecords.status, 'active'),
      ),
    );
  const existingTitles = existingRecords.map((r) => r.title);

  const existingGlossary = await db
    .select({ term: s.glossaryTerms.term })
    .from(s.glossaryTerms)
    .where(eq(s.glossaryTerms.trackId, trackId));
  const existingGlossaryTerms = existingGlossary.map((g) => g.term);

  // ── Step 2: LLM call ──────────────────────────────────────────────────────
  const llmOutput = await llmObject({
    purpose: 'distill-records',
    tier: 'classifier',
    schema: distillOutputSchema,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt({ objective, evidenceSummary, existingTitles, existingGlossaryTerms }),
    modelOverride: opts.modelOverride,
  });

  // ── Code-side admission gate dedup ────────────────────────────────────────
  const existingTitlesLower = new Set(existingTitles.map((t) => t.toLowerCase()));
  const filteredRecords = llmOutput.records.filter(
    (r) => !existingTitlesLower.has(r.title.toLowerCase()),
  );

  const existingTermsLower = new Set(existingGlossaryTerms.map((t) => t.toLowerCase()));
  const filteredPromotions = llmOutput.glossaryPromotions.filter(
    (p) => !existingTermsLower.has(p.term.toLowerCase()),
  );

  // ── Steps 3-6: Transactional insert ──────────────────────────────────────
  const result = await db.transaction(async (tx) => {
    const recordIds: string[] = [];
    let umbrellaRecordId: string | null = null;

    // Step 3: Insert records
    for (const rec of filteredRecords) {
      const seq = await nextRecordSeq(tx as unknown as Tx, trackId);
      const [inserted] = await tx
        .insert(s.learningRecords)
        .values({
          trackId,
          seq,
          recordType: rec.recordType,
          title: rec.title,
          body: rec.body,
          implications: rec.implications ?? null,
          evidence: {
            lessonId: opts.lessonId,
            attemptEventIds,
            source: 'distiller',
          },
        })
        .returning({ id: s.learningRecords.id });
      recordIds.push(inserted.id);
    }

    // Step 4: Umbrella record — if LLM returned promotions but zero records
    if (filteredPromotions.length > 0 && recordIds.length === 0) {
      const seq = await nextRecordSeq(tx as unknown as Tx, trackId);
      const lessonObjective = objective;
      const [umbrella] = await tx
        .insert(s.learningRecords)
        .values({
          trackId,
          seq,
          recordType: 'demonstrated_understanding',
          title: `Completed: ${lessonObjective}`,
          body: `The learner completed the lesson on "${lessonObjective}" and demonstrated understanding through the win-check.`,
          evidence: {
            lessonId: opts.lessonId,
            attemptEventIds,
            source: 'distiller',
          },
        })
        .returning({ id: s.learningRecords.id });
      umbrellaRecordId = umbrella.id;
      recordIds.push(umbrellaRecordId);
    }

    // The anchor record id for glossary FK (first inserted record or umbrella)
    const anchorRecordId = recordIds[0] ?? null;

    // Step 4b: Insert glossary promotions
    const promotedTermIds: string[] = [];
    if (anchorRecordId) {
      for (const promo of filteredPromotions) {
        // onConflictDoNothing in case of race; filter already guards against duplicates
        const [inserted] = await tx
          .insert(s.glossaryTerms)
          .values({
            trackId,
            term: promo.term,
            definition: promo.definition,
            promotionEvidenceRecordId: anchorRecordId,
          })
          .onConflictDoNothing()
          .returning({ id: s.glossaryTerms.id });
        if (inserted) {
          promotedTermIds.push(inserted.id);
        }
      }
    }

    // Step 5: createCardForGlossaryTerm for each promotion (FSRS bridge).
    // Pass `tx` so the FK to glossary_terms (inserted above) is visible within the same transaction.
    const cardIds: string[] = [];
    for (const termId of promotedTermIds) {
      const { id: cardId } = await createCardForGlossaryTerm(tx as unknown as Db, {
        learnerId: opts.learnerId,
        glossaryTermId: termId,
      });
      cardIds.push(cardId);
    }

    // Step 6: Node mastery — demonstrated if ≥1 demonstrated_understanding record inserted
    const hasDemonstrated = filteredRecords.some(
      (r) => r.recordType === 'demonstrated_understanding',
    ) || (umbrellaRecordId !== null);

    if (hasDemonstrated) {
      const snapshot = lesson.zpdSnapshot as { nodeId?: string };
      if (snapshot?.nodeId) {
        await tx
          .update(s.skillNodes)
          .set({ mastery: 'demonstrated' })
          .where(
            and(
              eq(s.skillNodes.id, snapshot.nodeId),
              eq(s.skillNodes.trackId, trackId),
            ),
          );
      }
    }

    return { recordIds, promotedTermIds, cardIds };
  });

  // ── Step 7: Reference doc — only when records were inserted ──────────────
  let referenceDocId: string | null = null;

  if (result.recordIds.length > 0) {
    // Build the list of records and promotions to pass as context.
    const docContextRecords = filteredRecords.map((r) => ({ title: r.title, body: r.body }));
    const docContextPromotions = filteredPromotions.map((p) => ({ term: p.term, definition: p.definition }));

    const refDocOutput = await llmObject({
      purpose: 'create-reference-doc',
      tier: 'generator',
      schema: createReferenceDocSchema,
      system: REFERENCE_DOC_SYSTEM_PROMPT,
      prompt: buildReferenceDocPrompt({
        objective,
        records: docContextRecords,
        promotions: docContextPromotions,
      }),
      modelOverride: opts.modelOverride,
    });

    // Upsert reference_docs by (trackId, title):
    //   - If a doc with this title exists for the track: update content + append lessonId
    //   - Else: insert with linkedLessonIds = [lessonId]
    const content = { sections: refDocOutput.sections };

    const [existing] = await db
      .select({ id: s.referenceDocs.id })
      .from(s.referenceDocs)
      .where(
        and(
          eq(s.referenceDocs.trackId, trackId),
          eq(s.referenceDocs.title, refDocOutput.title),
        ),
      )
      .limit(1);

    if (existing) {
      // Update content, append lessonId to linkedLessonIds if not already present.
      // Uses a parameterized cast: $1::uuid is compared against the array elements.
      await db
        .update(s.referenceDocs)
        .set({
          content,
          updatedAt: new Date(),
          linkedLessonIds: sql`
            CASE WHEN ${opts.lessonId}::uuid = ANY(${s.referenceDocs.linkedLessonIds})
            THEN ${s.referenceDocs.linkedLessonIds}
            ELSE array_append(${s.referenceDocs.linkedLessonIds}, ${opts.lessonId}::uuid)
            END`,
        })
        .where(eq(s.referenceDocs.id, existing.id));
      referenceDocId = existing.id;
    } else {
      const [inserted] = await db
        .insert(s.referenceDocs)
        .values({
          trackId,
          title: refDocOutput.title,
          docType: refDocOutput.docType,
          content,
          linkedLessonIds: [opts.lessonId],
        })
        .returning({ id: s.referenceDocs.id });
      referenceDocId = inserted.id;
    }
  }

  return {
    inserted: result.recordIds.length > 0,
    skipped: false,
    referenceDocId,
    ...result,
  };
}
