/**
 * distill-lesson workflow — Phase 5b.
 *
 * Single step: calls distillLesson.
 * No progress events (no UI yet).
 *
 * Triggered fire-and-forget from the attempts route after a win-check pass
 * (after recordWinCheckResult). Errors are logged but do not propagate to
 * the HTTP response.
 */

import { db } from '@/lib/db';
import { distillLesson } from '@/server/lessons/distiller';

async function runDistill(lessonId: string, learnerId: string) {
  'use step';
  return distillLesson(db, { lessonId, learnerId });
}

export async function distillLessonWorkflow(lessonId: string, learnerId: string) {
  'use workflow';
  return runDistill(lessonId, learnerId);
}
