/**
 * /billing — Subscription & credit-ledger page.
 *
 * Server component: reads balance, subscription status, and ledger history
 * from the DB at render time. Passes data to BillingActions (client island)
 * for checkout/portal interactions.
 *
 * URL state:
 *   ?success=1 — shown after Stripe redirects back from a successful checkout.
 *
 * a11y: semantic <table> markup, labeled buttons, sun palette only on large text.
 */

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { balance, ensureMonthlyGrant } from '@/lib/credits';
import { getLedgerHistory, getSubscriptionStatus } from '@/lib/billing-queries';
import { BillingActions } from './billing-actions';

const ENTRY_TYPE_LABELS: Record<string, string> = {
  grant: 'Monthly grant',
  purchase: 'Subscription payment',
  hold: 'Lesson started (credit held)',
  capture: 'Lesson completed',
  refund: 'Lesson refunded',
};

function formatDate(d: Date): string {
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusLabel(status: 'none' | 'active' | 'canceled'): string {
  if (status === 'active') return 'Active';
  if (status === 'canceled') return 'Canceled';
  return 'Free';
}

function statusClasses(status: 'none' | 'active' | 'canceled'): string {
  if (status === 'active') return 'bg-sky-100 text-sky-700';
  if (status === 'canceled') return 'bg-ink-400/10 text-ink-600';
  return 'bg-sun-100 text-sun-700';
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string }>;
}) {
  const params = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const userId = session.user.id;
  // Materialize the free monthly grant before reading the balance so a new/free
  // user sees 3 credits instead of 0 (ensureMonthlyGrant is idempotent + advisory-locked).
  await ensureMonthlyGrant(db, userId);
  const [bal, subscriptionStatus, ledger] = await Promise.all([
    balance(db, userId),
    getSubscriptionStatus(db, userId),
    getLedgerHistory(db, userId, 25),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-medium text-ink-900">Billing</h1>

      {/* Success banner after Stripe redirect */}
      {params.success === '1' && (
        <div
          className="mt-4 rounded-xl border border-sky-300 bg-sky-50 px-5 py-3"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm font-medium text-sky-700">
            Subscription activated — your credits have been added.
          </p>
        </div>
      )}

      {/* Status card */}
      <section
        className="mt-6 rounded-xl border border-ink-400/20 bg-cloud p-6 shadow-sm"
        aria-label="Subscription status"
      >
        <div className="flex items-center gap-3">
          <h2 className="text-base font-medium text-ink-900">Plan</h2>
          <span
            className={`rounded-full px-3 py-0.5 text-sm font-semibold capitalize ${statusClasses(subscriptionStatus)}`}
            aria-label={`Subscription status: ${statusLabel(subscriptionStatus)}`}
          >
            {statusLabel(subscriptionStatus)}
          </span>
        </div>

        <p className="mt-1 text-sm text-ink-600">
          {subscriptionStatus === 'active'
            ? '30 credits per month (renews automatically).'
            : subscriptionStatus === 'canceled'
            ? 'Your subscription has been canceled. Credits may still be available.'
            : '3 free lesson credits per month. Upgrade for more.'}
        </p>

        <div className="mt-5">
          <BillingActions
            subscriptionStatus={subscriptionStatus}
            balance={bal}
          />
        </div>
      </section>

      {/* Credit history */}
      <section className="mt-8" aria-label="Credit history">
        <h2 className="text-lg font-medium text-ink-900">Credit history</h2>
        <p className="mt-1 text-sm text-ink-600">
          Most recent {Math.min(ledger.length, 25)} transactions.
        </p>

        {ledger.length === 0 ? (
          <p className="mt-4 text-sm text-ink-400">No transactions yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-ink-400/20">
            <table className="min-w-full text-sm">
              <thead className="border-b border-ink-400/20 bg-cloud">
                <tr>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-400"
                  >
                    Type
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-ink-400"
                  >
                    Amount
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-ink-400"
                  >
                    Date
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-400/10">
                {ledger.map((row) => (
                  <tr key={row.id} data-testid="ledger-row" className="bg-white hover:bg-sky-50">
                    <td className="px-4 py-3 text-ink-700">
                      {ENTRY_TYPE_LABELS[row.entryType] ?? row.entryType}
                      {row.hasStripeRef && (
                        <span className="ml-1.5 text-xs text-ink-400">(Stripe)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      <span
                        className={
                          row.amount > 0
                            ? 'text-sky-700'
                            : row.amount < 0
                            ? 'text-ink-600'
                            : 'text-ink-400'
                        }
                        aria-label={row.amount === 0 ? 'settlement marker' : undefined}
                      >
                        {row.amount > 0 ? `+${row.amount}` : row.amount === 0 ? '—' : row.amount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-ink-600">
                      {formatDate(row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
