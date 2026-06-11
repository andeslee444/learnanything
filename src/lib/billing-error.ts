/**
 * Billing error classification — pure function, no I/O, no React.
 *
 * Maps raw API error codes returned by /api/billing/* routes into
 * user-friendly strings safe to display in the UI.
 *
 * Known codes:
 *   'unauthenticated'  — Cognito session missing / expired (401)
 *   'no_subscription'  — portal called with no billing_customers row (404)
 *   anything else      — generic fallback
 */
export function friendlyBillingError(code: string | undefined): string {
  if (code === 'unauthenticated') return 'Your session expired — please sign in again.';
  if (code === 'no_subscription') return 'No subscription found.';
  return 'Something went wrong — please try again.';
}
