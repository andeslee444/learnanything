'use client';

/**
 * BillingActions — client island for the /billing page.
 *
 * Handles checkout → redirect and portal → redirect.
 * On 503 (billing not configured) renders a notice in place of the button.
 * On 409 (already_subscribed) from checkout, refresh-hints the server so the
 * server component can re-render with the updated status. The hint is shown
 * only while the router refresh is in flight (isPending) so it auto-clears.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { friendlyBillingError } from '@/lib/billing-error';

type Props = {
  subscriptionStatus: 'none' | 'active' | 'canceled';
  balance: number;
};

type ActionState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }     // 503 — billing not configured
  | { kind: 'already_subscribed' } // 409
  | { kind: 'error'; message: string };

export function BillingActions({ subscriptionStatus, balance }: Props) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();
  // isPending is true from the startTransition(router.refresh()) call in the 409
  // handler until the router re-render lands, giving the hint a natural lifespan.

  // ── Checkout ────────────────────────────────────────────────────────────────

  async function handleSubscribe() {
    if (state.kind === 'loading') return;
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/billing/checkout', { method: 'POST' });

      if (res.status === 503) {
        setState({ kind: 'unavailable' });
        return;
      }
      if (res.status === 409) {
        // Already subscribed — refresh so the server component re-reads DB.
        // Wrap in startTransition so isPending stays true until the re-render
        // lands; the hint renders only while isPending, so it disappears once
        // the refresh completes and the button flips to "Manage subscription".
        setState({ kind: 'already_subscribed' });
        startTransition(() => { router.refresh(); });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setState({ kind: 'error', message: friendlyBillingError(body.error) });
        return;
      }

      const { url } = await res.json() as { url: string | null };
      if (url) {
        window.location.href = url;
      } else {
        setState({ kind: 'error', message: 'No redirect URL from Stripe — please try again.' });
      }
    } catch {
      setState({ kind: 'error', message: 'Network error — please check your connection.' });
    }
  }

  // ── Portal ──────────────────────────────────────────────────────────────────

  async function handleManage() {
    if (state.kind === 'loading') return;
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });

      if (res.status === 503) {
        setState({ kind: 'unavailable' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setState({ kind: 'error', message: friendlyBillingError(body.error) });
        return;
      }

      const { url } = await res.json() as { url: string };
      if (url) {
        window.location.href = url;
      } else {
        setState({ kind: 'error', message: 'No redirect URL from Stripe — please try again.' });
      }
    } catch {
      setState({ kind: 'error', message: 'Network error — please check your connection.' });
    }
  }

  // ── Unavailable notice (503 / no-key dev/CI state) ─────────────────────────

  if (state.kind === 'unavailable') {
    return (
      <div
        data-testid="billing-unavailable"
        role="alert"
        className="rounded-xl border border-sun-300 bg-sun-100 px-5 py-4"
      >
        <p className="text-sm font-medium text-sun-700">Billing isn&apos;t configured yet</p>
        <p className="mt-1 text-xs text-ink-600">
          Stripe credentials haven&apos;t been set up for this environment.
          Contact the site administrator.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Balance & plan summary */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-ink-600">
          Current balance:{' '}
          <strong className="text-ink-900">{balance} credit{balance !== 1 ? 's' : ''}</strong>
        </span>
      </div>

      {/* Primary CTA */}
      {subscriptionStatus !== 'active' ? (
        <button
          type="button"
          data-testid="billing-subscribe"
          onClick={handleSubscribe}
          disabled={state.kind === 'loading'}
          className="w-fit rounded-xl bg-sky-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          aria-label="Subscribe for $15 per month"
        >
          {state.kind === 'loading' ? 'Redirecting…' : 'Subscribe — $15/mo'}
        </button>
      ) : (
        <button
          type="button"
          data-testid="billing-manage"
          onClick={handleManage}
          disabled={state.kind === 'loading'}
          className="w-fit rounded-xl border border-ink-400/30 bg-cloud px-6 py-2.5 text-sm font-medium text-ink-600 hover:bg-sky-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          aria-label="Manage your subscription"
        >
          {state.kind === 'loading' ? 'Redirecting…' : 'Manage subscription'}
        </button>
      )}

      {/* Already-subscribed (409 edge case) — shown only while the router refresh
          is in flight; auto-clears once the server re-render lands. */}
      {state.kind === 'already_subscribed' && isPending && (
        <p
          className="text-xs text-sky-600"
          role="status"
          aria-live="polite"
        >
          You already have an active subscription — refreshing your status…
        </p>
      )}

      {/* General error */}
      {state.kind === 'error' && (
        <p className="text-sm text-red-600" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}

// ── UpgradePrompt — used by LessonSection when API returns 402 ───────────────

type UpgradePromptProps = {
  onDismiss?: () => void;
};

/**
 * Displayed when the lesson POST returns 402 (insufficient credits).
 * Links to /billing with a clear call-to-action.
 */
export function UpgradePrompt({ onDismiss }: UpgradePromptProps) {
  return (
    <div
      data-testid="upgrade-prompt"
      role="alert"
      className="mt-4 rounded-xl border border-sun-300 bg-sun-100 px-5 py-4"
    >
      <p className="text-sm font-medium text-sun-700">Out of credits</p>
      <p className="mt-1 text-xs text-ink-600">
        You&apos;ve used all your lesson credits for this month.{' '}
        <Link
          href="/billing"
          className="text-sky-600 underline underline-offset-2 hover:text-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Upgrade to get 30 credits/month (plus your 3 free monthly credits)
        </Link>{' '}
        for $15/mo.
      </p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 text-xs text-ink-400 hover:text-ink-600 underline underline-offset-1 focus:outline-none"
          aria-label="Dismiss credit notice"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
