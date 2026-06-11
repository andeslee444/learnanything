/**
 * Founder alert seam — v1 implementation.
 *
 * Structured console.warn with a greppable '[founder-alert]' prefix.
 * All alert channels (faithfulness, moderation flags, crisis) flow through this
 * single function so Phase 8 can swap in an email channel in one place.
 */

export type AlertKind = 'faithfulness' | 'moderation_flag' | 'crisis';

/**
 * Fire a structured founder alert.
 * v1: console.warn — Phase 8 will add an email channel here.
 */
export function alertFounder(kind: AlertKind, payload: Record<string, unknown>): void {
  console.warn('[founder-alert]', kind, JSON.stringify(payload));
}
