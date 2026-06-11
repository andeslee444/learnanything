/**
 * Lesson error classification — pure function, no I/O.
 *
 * Parses an HTTP status + JSON body from POST /api/tracks/[id]/lessons into
 * a discriminated string for the LessonSection state machine.
 *
 * Returns:
 *   'credits'           — 402 (insufficient credits; show UpgradePrompt)
 *   'already_generating'— 409 + body.error === 'already_generating'
 *   'error'             — any other non-OK status
 *   null                — success (2xx)
 */

export type LessonErrorKind =
  | 'credits'
  | 'already_generating'
  | 'error'
  | null;

export function classifyLessonError(
  status: number,
  body: { error?: string } | null,
): LessonErrorKind {
  if (status >= 200 && status < 300) return null;
  if (status === 402) return 'credits';
  if (status === 409 && body?.error === 'already_generating') return 'already_generating';
  return 'error';
}
