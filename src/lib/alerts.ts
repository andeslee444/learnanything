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

export type AlertKind = 'faithfulness' | 'moderation_flag' | 'crisis';

/**
 * Fire a structured founder alert.
 * Always console.warn. When ADMIN_EMAILS set, also emails the first admin.
 * Fire-and-forget with .catch so alerts never throw into callers.
 */
export function alertFounder(kind: AlertKind, payload: Record<string, unknown>): void {
  console.warn('[founder-alert]', kind, JSON.stringify(payload));

  const adminEmails = process.env.ADMIN_EMAILS;
  if (adminEmails) {
    const firstAdmin = adminEmails.split(',')[0].trim();
    if (firstAdmin) {
      sendEmail({
        to: firstAdmin,
        subject: `[LearnAnything alert] ${kind}`,
        // Payloads are content-free by discipline — JSON.stringify is safe.
        text: JSON.stringify(payload),
      }).catch(() => {
        // Fire-and-forget: swallow errors so alerts never throw into callers.
      });
    }
  }
}
