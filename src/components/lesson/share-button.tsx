'use client';

import { useState } from 'react';

type ShareButtonProps = {
  lessonId: string;
};

type State =
  | { kind: 'idle' }
  | { kind: 'sharing' }
  | { kind: 'shared'; slug: string; url: string }
  | { kind: 'unsharing' }
  | { kind: 'error'; message: string };

/**
 * ShareButton — share/unshare a ready lesson (Phase 10 T2).
 *
 * POST /api/lessons/[lessonId]/share → share (idempotent)
 * DELETE /api/lessons/[lessonId]/share → unshare
 *
 * Inline error surfacing:
 *  - 422 → "This lesson can't be shared publicly."
 *  - 503 → "Sharing is temporarily unavailable — please try again."
 *  - other → generic
 *
 * Accessibility:
 *  - share button: aria-label "Share this lesson"
 *  - unshare button: aria-label "Unshare this lesson"
 *  - url link: aria-label "Public lesson URL"
 *  - copy button: aria-label "Copy public URL"
 */
export function ShareButton({ lessonId }: ShareButtonProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function handleShare() {
    if (state.kind === 'sharing' || state.kind === 'unsharing') return;
    setState({ kind: 'sharing' });

    let res: Response;
    try {
      res = await fetch(`/api/lessons/${lessonId}/share`, { method: 'POST' });
    } catch {
      setState({ kind: 'error', message: 'Network error — please try again.' });
      return;
    }

    if (res.status === 422) {
      setState({ kind: 'error', message: "This lesson can't be shared publicly." });
      return;
    }
    if (res.status === 503) {
      setState({ kind: 'error', message: 'Sharing is temporarily unavailable — please try again.' });
      return;
    }
    if (res.status === 409) {
      setState({ kind: 'error', message: 'The lesson is not ready to share yet.' });
      return;
    }
    if (!res.ok) {
      setState({ kind: 'error', message: 'Could not share the lesson — please try again.' });
      return;
    }

    const data = (await res.json()) as { slug: string; url: string };
    setState({ kind: 'shared', slug: data.slug, url: data.url });
  }

  async function handleUnshare() {
    if (state.kind === 'sharing' || state.kind === 'unsharing') return;
    setState({ kind: 'unsharing' });

    let res: Response;
    try {
      res = await fetch(`/api/lessons/${lessonId}/share`, { method: 'DELETE' });
    } catch {
      setState({ kind: 'error', message: 'Network error — please try again.' });
      return;
    }

    if (!res.ok) {
      setState({ kind: 'error', message: 'Could not unshare the lesson — please try again.' });
      return;
    }

    setState({ kind: 'idle' });
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(window.location.origin + url);
    } catch {
      // Silently fail if clipboard API unavailable
    }
  }

  if (state.kind === 'shared') {
    return (
      <div
        data-testid="share-section"
        className="mt-4 rounded-xl border border-green-200 bg-green-50/40 px-5 py-4"
      >
        <p className="text-sm font-medium text-green-800 mb-2">Shared! Public link:</p>
        <div className="flex flex-wrap items-center gap-2">
          <a
            data-testid="share-url"
            href={state.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Public lesson URL"
            className="flex-1 min-w-0 truncate rounded border border-green-300 bg-white px-3 py-1.5 text-sm text-green-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
          >
            {state.url}
          </a>
          <button
            onClick={() => handleCopy(state.url)}
            aria-label="Copy public URL"
            className="shrink-0 rounded-lg border border-green-300 bg-white px-3 py-1.5 text-sm font-medium text-green-800 hover:bg-green-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
          >
            Copy
          </button>
        </div>
        <button
          data-testid="unshare-lesson"
          onClick={handleUnshare}
          disabled={state.kind === ('unsharing' as string)}
          aria-label="Unshare this lesson"
          className="mt-3 inline-flex items-center gap-1 text-sm text-red-600 hover:text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-60"
        >
          Remove public link
        </button>
      </div>
    );
  }

  return (
    <div data-testid="share-section" className="mt-4">
      {state.kind === 'error' && (
        <p className="mb-2 text-sm text-red-600" role="alert">
          {state.message}
        </p>
      )}
      <button
        data-testid="share-lesson"
        onClick={handleShare}
        disabled={state.kind === 'sharing'}
        aria-label="Share this lesson"
        className="inline-flex items-center gap-2 rounded-lg border border-sky-300 bg-white px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {state.kind === 'sharing' ? (
          <>
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-sky-300 border-t-sky-600"
              aria-hidden="true"
            />
            Sharing…
          </>
        ) : (
          <>
            {/* Share icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M13 4.5a2.5 2.5 0 11.702 1.737L6.97 9.604a2.518 2.518 0 010 .793l6.733 3.367a2.5 2.5 0 11-.671 1.341l-6.733-3.367a2.5 2.5 0 110-3.475l6.733-3.367A2.52 2.52 0 0113 4.5z" />
            </svg>
            Share
          </>
        )}
      </button>
    </div>
  );
}
