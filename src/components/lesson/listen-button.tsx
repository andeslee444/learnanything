'use client';

import { useState } from 'react';

type ListenButtonProps = {
  lessonId: string;
};

type State =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; audioUrl: string; transcript: string }
  | { kind: 'error'; message: string };

/**
 * ListenButton — TTS narration entry point for a ready lesson (Phase 8).
 *
 * Click → POST /api/lessons/[lessonId]/narration (idempotent; synthesizes once).
 * On success → fetches transcript and renders <audio> player + collapsible transcript.
 *
 * Accessibility:
 *   - button has aria-label "Listen to this lesson"
 *   - <audio> has aria-label "Lesson narration audio"
 *   - <details> transcript is labelled "Transcript"
 */
export function ListenButton({ lessonId }: ListenButtonProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function handleListen() {
    if (state.kind === 'generating') return;
    if (state.kind === 'ready') return; // already playing

    setState({ kind: 'generating' });

    // Step 1: POST to generate (idempotent)
    let postRes: Response;
    try {
      postRes = await fetch(`/api/lessons/${lessonId}/narration`, { method: 'POST' });
    } catch {
      setState({ kind: 'error', message: 'Network error — please try again.' });
      return;
    }

    if (postRes.status === 429) {
      setState({ kind: 'error', message: 'Please wait a moment before trying again.' });
      return;
    }
    if (postRes.status === 409) {
      setState({ kind: 'error', message: 'Narration is not available yet — the lesson may still be generating.' });
      return;
    }
    if (!postRes.ok) {
      setState({ kind: 'error', message: 'Could not generate narration — please try again.' });
      return;
    }

    // Step 2: Fetch transcript
    let transcript = '';
    try {
      const transcriptRes = await fetch(`/api/lessons/${lessonId}/narration?transcript=1`);
      if (transcriptRes.ok) {
        const data = (await transcriptRes.json()) as { transcript?: string };
        transcript = data.transcript ?? '';
      }
    } catch {
      // Transcript fetch failing is non-fatal; audio still plays
    }

    // Step 3: Audio URL (served by GET route)
    const audioUrl = `/api/lessons/${lessonId}/narration`;
    setState({ kind: 'ready', audioUrl, transcript });
  }

  if (state.kind === 'ready') {
    return (
      <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50/40 px-5 py-4">
        <audio
          data-testid="lesson-audio"
          controls
          src={state.audioUrl}
          aria-label="Lesson narration audio"
          className="w-full"
        />
        {state.transcript && (
          <details className="mt-3" data-testid="narration-transcript">
            <summary className="cursor-pointer text-sm font-medium text-sky-700 hover:text-sky-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
              Transcript
            </summary>
            <p className="mt-2 text-sm text-ink-700 leading-relaxed whitespace-pre-line">
              {state.transcript}
            </p>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4">
      {state.kind === 'error' && (
        <p className="mb-2 text-sm text-red-600" role="alert">
          {state.message}
        </p>
      )}
      <button
        data-testid="listen-button"
        onClick={handleListen}
        disabled={state.kind === 'generating'}
        aria-label="Listen to this lesson"
        className="inline-flex items-center gap-2 rounded-lg border border-sky-300 bg-white px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {state.kind === 'generating' ? (
          <>
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-sky-300 border-t-sky-600"
              aria-hidden="true"
            />
            Preparing audio…
          </>
        ) : (
          <>
            {/* Speaker icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M10 3.75a.75.75 0 00-1.264-.546L4.703 7H3.167a.75.75 0 00-.75.75v4.5c0 .414.336.75.75.75h1.536l4.033 3.796A.75.75 0 0010 16.25V3.75z" />
              <path d="M15.95 5.05a.75.75 0 00-1.06 1.06A6.5 6.5 0 0117 10a6.5 6.5 0 01-2.11 4.89.75.75 0 001.06 1.06A8 8 0 0019 10a8 8 0 00-3.05-4.95z" />
              <path d="M13.828 7.172a.75.75 0 00-1.06 1.06A3.5 3.5 0 0114 10a3.5 3.5 0 01-1.232 2.768.75.75 0 001.06 1.06A5 5 0 0016 10a5 5 0 00-2.172-2.828z" />
            </svg>
            Listen
          </>
        )}
      </button>
    </div>
  );
}
