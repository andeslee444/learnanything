'use client';

/**
 * ReportButton — client island for the public lesson page.
 *
 * Clicking opens a reason picker (4 enum reasons: inaccurate / inappropriate /
 * copyright / other), POSTs to the report endpoint, then thanks the reporter.
 * No free text — content-free discipline (spec §7).
 */

import { useState } from 'react';

const REASONS = [
  { value: 'inaccurate', label: 'Inaccurate information' },
  { value: 'inappropriate', label: 'Inappropriate content' },
  { value: 'copyright', label: 'Copyright violation' },
  { value: 'other', label: 'Other concern' },
] as const;

type Reason = typeof REASONS[number]['value'];
type State = 'idle' | 'open' | 'submitting' | 'thanked' | 'error';

type Props = {
  slug: string;
};

export function ReportButton({ slug }: Props) {
  const [state, setState] = useState<State>('idle');
  const [selected, setSelected] = useState<Reason | null>(null);

  function handleOpen() {
    setState('open');
    setSelected(null);
  }

  function handleCancel() {
    setState('idle');
    setSelected(null);
  }

  async function handleSubmit() {
    if (!selected || state === 'submitting') return;
    setState('submitting');
    try {
      const res = await fetch(`/api/shared/${slug}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: selected }),
      });
      if (res.status === 429) {
        setState('error');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      setState('thanked');
    } catch {
      setState('error');
    }
  }

  if (state === 'thanked') {
    return (
      <p
        data-testid="report-lesson"
        className="text-xs text-ink-400"
        role="status"
      >
        Thank you — your report has been received.
      </p>
    );
  }

  if (state === 'error') {
    return (
      <p
        data-testid="report-lesson"
        className="text-xs text-red-500"
        role="alert"
      >
        Could not submit report — please try again later.
      </p>
    );
  }

  if (state === 'idle') {
    return (
      <button
        data-testid="report-lesson"
        type="button"
        onClick={handleOpen}
        className="text-xs text-ink-400 hover:text-red-500 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        Report this lesson
      </button>
    );
  }

  // open or submitting
  return (
    <div
      data-testid="report-lesson"
      className="rounded-xl border border-ink-400/20 bg-white px-5 py-4 text-sm shadow-sm"
      role="dialog"
      aria-label="Report this lesson"
    >
      <p className="font-medium text-ink-900 mb-3">What is the concern?</p>
      <div className="flex flex-col gap-2">
        {REASONS.map(({ value, label }) => (
          <label key={value} className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="report-reason"
              value={value}
              checked={selected === value}
              onChange={() => setSelected(value)}
              disabled={state === 'submitting'}
              className="accent-sky-600 focus:ring-sky-400"
            />
            <span className="text-ink-700">{label}</span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!selected || state === 'submitting'}
          className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {state === 'submitting' ? 'Submitting…' : 'Submit report'}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={state === 'submitting'}
          className="rounded-lg border border-ink-400/20 px-4 py-1.5 text-xs text-ink-600 hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
