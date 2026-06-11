/**
 * Founder alert seam — Phase 8 implementation.
 *
 * Structured console.warn with a greppable '[founder-alert]' prefix.
 * All alert channels (faithfulness, moderation flags, crisis) flow through this
 * single function.
 *
 * Phase 8: when ADMIN_EMAILS is set, ALSO sends an email to the first admin.
 * Payloads are already content-free by discipline — safe to include as JSON.
 * Fire-and-forget: email failures never propagate to callers.
 */

import { sendEmail } from './email';

export type AlertKind = 'faithfulness' | 'moderation_flag' | 'crisis' | 'billing' | 'report';

/**
 * Fire a structured founder alert.
 * Always console.warn (full payload including reason — log-only is fine for server logs).
 * When ADMIN_EMAILS set, also emails the first admin with `reason` stripped.
 * Fire-and-forget with .catch so alerts never throw into callers.
 */
export function alertFounder(kind: AlertKind, payload: Record<string, unknown>): void {
  // Full payload (including reason) goes to server logs only — greppable, not emailed.
  console.warn('[founder-alert]', kind, JSON.stringify(payload));

  const adminEmails = process.env.ADMIN_EMAILS;
  if (adminEmails) {
    const firstAdmin = adminEmails.split(',')[0].trim();
    if (firstAdmin) {
      // Content discipline: LLM-generated `reason` may quote learner content — log-only, never email.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { reason: _reason, ...emailSafe } = payload;
      sendEmail({
        to: firstAdmin,
        subject: `[LearnAnything alert] ${kind}`,
        text: JSON.stringify(emailSafe),
      }).catch(() => {
        // Fire-and-forget: swallow errors so alerts never throw into callers.
      });
    }
  }
}
