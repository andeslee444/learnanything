/**
 * account-export — builds the user data export.
 *
 * Exported as buildExport(db, userId, format) returning
 *   { body: string, contentType: string, filename: string }
 *
 * JSON export: one document covering the user's full data world.
 * Markdown export: Library view — per track mission, glossary, reference docs,
 * learning-record timeline.
 *
 * Testable without HTTP; the API routes are thin wrappers.
 */

import { eq, and, or, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;

export type ExportFormat = 'json' | 'markdown';

export type ExportResult = {
  body: string;
  contentType: string;
  filename: string;
};

// ── JSON export ───────────────────────────────────────────────────────────────

async function buildJsonExport(db: Db, userId: string): Promise<ExportResult> {
  // User
  const [userRow] = await db
    .select({ id: s.user.id, email: s.user.email, name: s.user.name, createdAt: s.user.createdAt })
    .from(s.user)
    .where(eq(s.user.id, userId))
    .limit(1);

  // Learner
  const [learnerRow] = await db
    .select()
    .from(s.learners)
    .where(eq(s.learners.userId, userId))
    .limit(1);

  // Credit ledger
  const ledger = await db
    .select()
    .from(s.creditLedger)
    .where(eq(s.creditLedger.userId, userId));

  // Billing customer
  const [billingCustomer] = await db
    .select({
      stripeCustomerId: s.billingCustomers.stripeCustomerId,
      subscriptionStatus: s.billingCustomers.subscriptionStatus,
      currentPeriodEnd: s.billingCustomers.currentPeriodEnd,
      createdAt: s.billingCustomers.createdAt,
    })
    .from(s.billingCustomers)
    .where(eq(s.billingCustomers.userId, userId))
    .limit(1);

  const tracksData: unknown[] = [];

  if (learnerRow) {
    const tracks = await db
      .select()
      .from(s.tracks)
      .where(eq(s.tracks.learnerId, learnerRow.id));

    for (const track of tracks) {
      // Mission
      const [mission] = await db
        .select()
        .from(s.missions)
        .where(eq(s.missions.trackId, track.id))
        .limit(1);

      // Mission revisions
      const missionRevisions = mission
        ? await db
            .select()
            .from(s.missionRevisions)
            .where(eq(s.missionRevisions.missionId, mission.id))
        : [];

      // Skill nodes
      const skillNodes = await db
        .select()
        .from(s.skillNodes)
        .where(eq(s.skillNodes.trackId, track.id));

      // Skill node edges
      const skillNodeIds = skillNodes.map((n) => n.id);
      const skillNodeEdges =
        skillNodeIds.length > 0
          ? await db
              .select()
              .from(s.skillNodeEdges)
              .where(inArray(s.skillNodeEdges.nodeId, skillNodeIds))
          : [];

      // Learning records (including superseded)
      const learningRecords = await db
        .select()
        .from(s.learningRecords)
        .where(eq(s.learningRecords.trackId, track.id));

      // Glossary terms
      const glossaryTerms = await db
        .select()
        .from(s.glossaryTerms)
        .where(eq(s.glossaryTerms.trackId, track.id));

      // Resources
      const resources = await db
        .select({
          id: s.resources.id,
          title: s.resources.title,
          url: s.resources.url,
          resourceType: s.resources.resourceType,
          kind: s.resources.kind,
          annotation: s.resources.annotation,
          extraction: s.resources.extraction,
          status: s.resources.status,
          createdAt: s.resources.createdAt,
        })
        .from(s.resources)
        .where(eq(s.resources.trackId, track.id));

      // Reference docs
      const referenceDocs = await db
        .select()
        .from(s.referenceDocs)
        .where(eq(s.referenceDocs.trackId, track.id));

      // Lessons
      const lessons = await db
        .select()
        .from(s.lessons)
        .where(eq(s.lessons.trackId, track.id));

      const lessonsWithDetails = await Promise.all(
        lessons.map(async (lesson) => {
          const verificationResults = await db
            .select()
            .from(s.verificationResults)
            .where(eq(s.verificationResults.lessonId, lesson.id));

          // Narration: transcript only, no audio blob
          const [narration] = await db
            .select({
              id: s.lessonNarrations.id,
              mimeType: s.lessonNarrations.mimeType,
              transcript: s.lessonNarrations.transcript,
              createdAt: s.lessonNarrations.createdAt,
            })
            .from(s.lessonNarrations)
            .where(eq(s.lessonNarrations.lessonId, lesson.id))
            .limit(1);

          return { ...lesson, verificationResults, narration: narration ?? null };
        })
      );

      // Attempt events for lessons in this track
      const lessonIds = lessons.map((l) => l.id);
      const attemptEvents =
        lessonIds.length > 0
          ? await db
              .select()
              .from(s.attemptEvents)
              .where(
                and(
                  eq(s.attemptEvents.learnerId, learnerRow.id),
                  inArray(s.attemptEvents.lessonId, lessonIds)
                )
              )
          : [];

      // Review cards for this learner scoped to this track's glossary terms and records
      const glossaryIds = glossaryTerms.map((g) => g.id);
      const recordIds = learningRecords.map((r) => r.id);

      const reviewCards =
        glossaryIds.length > 0 || recordIds.length > 0
          ? await db
              .select()
              .from(s.reviewCards)
              .where(
                and(
                  eq(s.reviewCards.learnerId, learnerRow.id),
                  or(
                    ...[
                      glossaryIds.length > 0
                        ? inArray(s.reviewCards.glossaryTermId, glossaryIds)
                        : null,
                      recordIds.length > 0
                        ? inArray(s.reviewCards.learningRecordId, recordIds)
                        : null,
                    ].filter(Boolean) as ReturnType<typeof inArray>[]
                  )
                )
              )
          : [];

      const reviewCardsWithLog = await Promise.all(
        reviewCards.map(async (card) => {
          const reviewLog = await db
            .select()
            .from(s.reviewLog)
            .where(eq(s.reviewLog.cardId, card.id));
          return { ...card, reviewLog };
        })
      );

      tracksData.push({
        track,
        mission: mission ?? null,
        missionRevisions,
        skillNodes,
        skillNodeEdges,
        learningRecords,
        glossaryTerms,
        resources,
        referenceDocs,
        lessons: lessonsWithDetails,
        attemptEvents,
        reviewCards: reviewCardsWithLog,
      });
    }

    // Attempt events with null lessonId (no track context)
    const nullLessonAttempts = await db
      .select()
      .from(s.attemptEvents)
      .where(and(eq(s.attemptEvents.learnerId, learnerRow.id), isNull(s.attemptEvents.lessonId)));

    if (nullLessonAttempts.length > 0) {
      tracksData.push({ track: null, attemptEvents: nullLessonAttempts });
    }
  }

  const doc = {
    exportedAt: new Date().toISOString(),
    user: userRow ?? null,
    learnerProfile: learnerRow
      ? {
          id: learnerRow.id,
          displayName: learnerRow.displayName,
          ageBand: learnerRow.ageBand,
          provenance: learnerRow.provenance,
          profile: learnerRow.profile,
          createdAt: learnerRow.createdAt,
        }
      : null,
    creditLedger: ledger,
    billingCustomer: billingCustomer ?? null,
    tracks: tracksData,
  };

  return {
    body: JSON.stringify(doc, null, 2),
    contentType: 'application/json',
    filename: 'learnanything-export.json',
  };
}

// ── Markdown export ───────────────────────────────────────────────────────────

async function buildMarkdownExport(db: Db, userId: string): Promise<ExportResult> {
  const [userRow] = await db
    .select({ email: s.user.email, name: s.user.name })
    .from(s.user)
    .where(eq(s.user.id, userId))
    .limit(1);

  const [learnerRow] = await db
    .select()
    .from(s.learners)
    .where(eq(s.learners.userId, userId))
    .limit(1);

  const lines: string[] = [];
  lines.push(`# LearnAnything — Library Export`);
  lines.push(`\nExported: ${new Date().toISOString()}`);
  if (userRow) lines.push(`User: ${userRow.name} (${userRow.email})`);
  lines.push('');

  if (!learnerRow) {
    lines.push('_No learner profile found._');
    return {
      body: lines.join('\n'),
      contentType: 'text/markdown; charset=utf-8',
      filename: 'learnanything-export.md',
    };
  }

  const tracks = await db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.learnerId, learnerRow.id));

  for (const track of tracks) {
    lines.push(`---\n`);
    lines.push(`## Track: ${track.topic}`);
    lines.push(`Status: ${track.status} | Expertise: ${track.expertiseBand}\n`);

    // Mission
    const [mission] = await db
      .select()
      .from(s.missions)
      .where(eq(s.missions.trackId, track.id))
      .limit(1);

    if (mission) {
      lines.push(`### Mission`);
      lines.push(`**Why:** ${mission.whyText}\n`);
    }

    // Glossary
    const glossaryTerms = await db
      .select()
      .from(s.glossaryTerms)
      .where(eq(s.glossaryTerms.trackId, track.id));

    if (glossaryTerms.length > 0) {
      lines.push(`### Terms you own`);
      for (const term of glossaryTerms) {
        lines.push(`- **${term.term}** — ${term.definition}`);
        if (term.ambiguityNote) lines.push(`  _Note: ${term.ambiguityNote}_`);
      }
      lines.push('');
    }

    // Reference docs
    const referenceDocs = await db
      .select()
      .from(s.referenceDocs)
      .where(eq(s.referenceDocs.trackId, track.id));

    if (referenceDocs.length > 0) {
      lines.push(`### Reference documents`);
      for (const doc of referenceDocs) {
        lines.push(`- **${doc.title}** (${doc.docType})`);
      }
      lines.push('');
    }

    // Learning record timeline
    const learningRecords = await db
      .select()
      .from(s.learningRecords)
      .where(eq(s.learningRecords.trackId, track.id));

    if (learningRecords.length > 0) {
      lines.push(`### Learning record timeline`);
      const sorted = [...learningRecords].sort((a, b) => a.seq - b.seq);
      for (const rec of sorted) {
        const status = rec.status === 'superseded' ? ' _(superseded)_' : '';
        lines.push(`${rec.seq}. **${rec.title}**${status}`);
        lines.push(`   ${rec.body}`);
      }
      lines.push('');
    }
  }

  return {
    body: lines.join('\n'),
    contentType: 'text/markdown; charset=utf-8',
    filename: 'learnanything-export.md',
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function buildExport(
  db: Db,
  userId: string,
  format: ExportFormat
): Promise<ExportResult> {
  if (format === 'markdown') return buildMarkdownExport(db, userId);
  return buildJsonExport(db, userId);
}
