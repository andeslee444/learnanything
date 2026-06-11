'use client';

/**
 * DataSection — "Data & account" section on the /billing page.
 *
 * Export JSON / Export Markdown — simple anchor links triggering downloads.
 * Delete account — danger zone with typed confirmation.
 *   - Input must equal 'DELETE' to enable the button.
 *   - On success, redirects to '/'.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function DataSection() {
  const router = useRouter();
  const [confirmValue, setConfirmValue] = useState('');
  const [deleteState, setDeleteState] = useState<
    'idle' | 'loading' | 'error'
  >('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const canDelete = confirmValue === 'DELETE';

  async function handleDelete() {
    if (!canDelete || deleteState === 'loading') return;
    setDeleteState('loading');
    setErrorMessage('');
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setErrorMessage(body.error ?? 'Delete failed — please try again.');
        setDeleteState('error');
        return;
      }
      // Redirect to home after successful deletion
      router.push('/');
    } catch {
      setErrorMessage('Network error — please check your connection.');
      setDeleteState('error');
    }
  }

  return (
    <section className="mt-10" aria-label="Data and account">
      <h2 className="text-lg font-medium text-ink-900">Data &amp; account</h2>
      <p className="mt-1 text-sm text-ink-600">
        Export a copy of your data or permanently delete your account.
      </p>

      {/* Export buttons */}
      <div className="mt-5 flex flex-wrap gap-3">
        <a
          href="/api/account/export?format=json"
          download="learnanything-export.json"
          data-testid="export-json"
          className="rounded-xl border border-sky-300 bg-sky-50 px-5 py-2.5 text-sm font-medium text-sky-700 hover:bg-sky-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Export JSON
        </a>
        <a
          href="/api/account/export?format=markdown"
          download="learnanything-export.md"
          data-testid="export-markdown"
          className="rounded-xl border border-sky-300 bg-sky-50 px-5 py-2.5 text-sm font-medium text-sky-700 hover:bg-sky-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Export Markdown
        </a>
      </div>

      {/* Danger zone */}
      <div className="mt-8 rounded-xl border border-red-200 bg-red-50 px-6 py-6">
        <h3 className="text-base font-semibold text-red-700">Danger zone</h3>
        <p className="mt-1 text-sm text-ink-700">
          Permanently delete your account and all data. This action cannot be undone. Encrypted
          backups are retained for up to 30 days after deletion, after which all data is
          permanently unrecoverable.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="delete-confirm-input"
              className="text-xs font-medium text-ink-700"
            >
              Type <strong>DELETE</strong> to confirm
            </label>
            <input
              id="delete-confirm-input"
              type="text"
              value={confirmValue}
              onChange={(e) => setConfirmValue(e.target.value)}
              placeholder="DELETE"
              data-testid="delete-confirm"
              className="w-48 rounded-lg border border-ink-400/30 bg-white px-3 py-2 text-sm text-ink-900 placeholder-ink-400 focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>
          <button
            type="button"
            data-testid="delete-account"
            onClick={handleDelete}
            disabled={!canDelete || deleteState === 'loading'}
            className="rounded-xl bg-red-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            {deleteState === 'loading' ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>

        {deleteState === 'error' && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {errorMessage}
          </p>
        )}
      </div>
    </section>
  );
}
