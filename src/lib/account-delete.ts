/**
 * account-delete — deletes a user account and all associated data.
 *
 * Exported as deleteAccount(db, userId) — deletes the user row and relies on
 * FK cascades to remove all child data. See cascade analysis in src/test/account.test.ts.
 *
 * Session invalidation: the session row is deleted by the user FK cascade
 * (session.userId → user.id ON DELETE CASCADE). The API route also clears
 * the Better-Auth session cookie so the browser won't send a stale token.
 *
 * Testable without HTTP; the DELETE route is a thin wrapper.
 */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;

export async function deleteAccount(db: Db, userId: string): Promise<void> {
  // Deleting the user row triggers FK cascades:
  //   user → session (cascade)
  //   user → account (cascade)
  //   user → learners (cascade)
  //     learners.parentUserId → user.id ON DELETE SET NULL (safe — sibling learners
  //       that reference this user as parent survive with parentUserId = null)
  //     learners → tracks (cascade)
  //       tracks → missions (cascade)
  //         missions → mission_revisions (cascade)
  //       tracks → learning_records (cascade)
  //         learning_records → glossary_terms (composite FK, cascade)
  //         learning_records → review_cards (cascade)
  //           review_cards → review_log (cascade)
  //       tracks → skill_nodes (cascade)
  //         skill_nodes → skill_node_edges (cascade)
  //       tracks → resources (cascade)
  //       tracks → reference_docs (cascade)
  //       tracks → resource_gaps (cascade)
  //     learners → attempt_events (cascade)
  //     learners → review_cards (cascade, via learner_id)
  //     learners → concept_ability (cascade)
  //   user → credit_ledger (cascade)
  //   user → billing_customers (cascade)
  //
  // Note: lesson_narrations and verification_results cascade from lessons,
  //       which cascade from tracks.
  //       shared_lessons cascades from lessons.
  await db.delete(s.user).where(eq(s.user.id, userId));
}
