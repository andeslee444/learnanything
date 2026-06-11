/**
 * Email seam — Phase 8 T3.
 *
 * sendEmail: {to, subject, text} → {sent: boolean, transport: 'resend'|'log'}
 *
 * RESEND_API_KEY absent → structured console.log (body NEVER logged — content discipline).
 * RESEND_API_KEY present → POST https://api.resend.com/emails (15s timeout, AbortController).
 *
 * Content discipline: this module MUST NOT log or expose the `text` field anywhere.
 * Callers are responsible for keeping `text` content-free (titles/objectives/counts only).
 */

export interface SendEmailArgs {
  to: string;
  subject: string;
  /** Plain-text email body. NEVER logged — content discipline. */
  text: string;
}

export interface SendEmailResult {
  sent: boolean;
  transport: 'resend' | 'log';
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/**
 * Send a plain-text email.
 *
 * Fake/log mode (RESEND_API_KEY absent):
 *   Logs `{to, subject}` only — the body is NEVER included (content discipline).
 *   Returns { sent: false, transport: 'log' }.
 *
 * Real mode (RESEND_API_KEY present):
 *   POST https://api.resend.com/emails with from/to/subject/text.
 *   15s AbortController guards the full exchange including body read.
 *   Returns { sent: true, transport: 'resend' } on success.
 *   Throws EmailSendError on failure.
 */
export async function sendEmail({ to, subject, text }: SendEmailArgs): Promise<SendEmailResult> {
  if (!process.env.RESEND_API_KEY) {
    // Log transport: structured, body never included.
    console.log('[email:log]', { to, subject });
    return { sent: false, transport: 'log' };
  }

  const from = process.env.NOTIFY_FROM ?? 'LearnAnything <onboarding@resend.dev>';

  const controller = new AbortController();
  // The timer guards the whole exchange including body read — matching narration.ts pattern.
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({ from, to, subject, text }),
      });
    } catch (err) {
      const msg =
        err instanceof Error && err.name === 'AbortError' ? 'Email request timed out' : 'Email request failed';
      throw new EmailSendError(msg);
    }

    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        // ignore body read error
      }
      throw new EmailSendError(`Resend API error: ${res.status} ${body.slice(0, 200)}`, res.status);
    }

    // Drain the body to avoid memory leaks, but don't use it.
    try {
      await res.text();
    } catch {
      // ignore
    }

    return { sent: true, transport: 'resend' };
  } finally {
    clearTimeout(timeout);
  }
}
