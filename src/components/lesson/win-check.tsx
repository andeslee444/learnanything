'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import type { QuizItem } from '@/server/lessons/blocks';

type ItemResult = {
  correct: boolean;
  explanation: string;
  winCheck?: { answered: number; total: number; passed?: boolean };
};

type WinCheckState =
  | { phase: 'answering'; itemIndex: number; result: ItemResult | null; submitting: boolean; chosenIndex: number | null }
  | { phase: 'passed'; objective: string }
  | { phase: 'failed' };

type Props = {
  lessonId: string;
  items: QuizItem[];
  objective: string;
  trackId: string;
  liveRef: React.RefObject<HTMLParagraphElement | null>;
};

export function WinCheck({ lessonId, items, objective, trackId, liveRef }: Props) {
  const [state, setState] = useState<WinCheckState>({
    phase: 'answering',
    itemIndex: 0,
    result: null,
    submitting: false,
    chosenIndex: null,
  });
  const mountedRef = useRef(true);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // useCallback keeps the ref callback stable across re-renders. The callback
  // sets mountedRef.current = true on mount and false on unmount (cleanup).
  // React Strict Mode calls setMounted(null) then setMounted(node) in dev — we
  // restore mountedRef.current on remount so the advance timer can fire.
  const setMounted = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      mountedRef.current = false;
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    } else {
      mountedRef.current = true;
    }
  }, []);

  async function handleAnswer(item: QuizItem, answerIndex: number) {
    if (state.phase !== 'answering') return;
    if (state.submitting || state.result !== null) return;

    setState((prev) => (prev.phase === 'answering' ? { ...prev, submitting: true, chosenIndex: answerIndex } : prev));

    try {
      const res = await fetch(`/api/lessons/${lessonId}/attempts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, answerIndex, kind: 'win_check' }),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        if (liveRef.current) liveRef.current.textContent = 'Something went wrong — please try again.';
        setState((prev) => (prev.phase === 'answering' ? { ...prev, submitting: false } : prev));
        return;
      }

      const data = (await res.json()) as ItemResult;

      // Write feedback to the live region
      if (liveRef.current) {
        liveRef.current.textContent = data.correct
          ? `Correct! ${data.explanation}`
          : `Not quite. ${data.explanation}`;
      }

      setState((prev) =>
        prev.phase === 'answering'
          ? { ...prev, submitting: false, result: data }
          : prev
      );

      const winCheckResult = data.winCheck;
      if (winCheckResult?.passed === true) {
        advanceTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          setState({ phase: 'passed', objective });
          if (liveRef.current) liveRef.current.textContent = `You passed! You can now: ${objective}`;
        }, 1200);
        return;
      }

      // Transition to failed phase when: server says answered>=total+not passed,
      // OR we are already on the last item and the response lacks passed:true.
      // The functional updater reads current itemIndex safely from the closure snapshot.
      const isLastItem = state.itemIndex >= items.length - 1;
      if (
        (winCheckResult && winCheckResult.answered >= winCheckResult.total && winCheckResult.passed === false) ||
        (isLastItem && !winCheckResult?.passed)
      ) {
        advanceTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          setState({ phase: 'failed' });
          if (liveRef.current) liveRef.current.textContent = 'Keep reviewing — you can try the win-check again.';
        }, 1200);
        return;
      }

      // Advance to next item — use functional updater so itemIndex is never stale.
      advanceTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setState((prev) => {
          if (prev.phase !== 'answering') return prev;
          return {
            phase: 'answering',
            itemIndex: prev.itemIndex + 1,
            result: null,
            submitting: false,
            chosenIndex: null,
          };
        });
        if (liveRef.current) liveRef.current.textContent = '';
      }, 1800);
    } catch {
      if (!mountedRef.current) return;
      setState((prev) => (prev.phase === 'answering' ? { ...prev, submitting: false } : prev));
      if (liveRef.current) liveRef.current.textContent = 'Network error — please try again.';
    }
  }

  function handleRetry() {
    setState({ phase: 'answering', itemIndex: 0, result: null, submitting: false, chosenIndex: null });
    if (liveRef.current) liveRef.current.textContent = '';
  }

  if (state.phase === 'passed') {
    return (
      <div
        data-testid="lesson-complete"
        ref={setMounted}
        className="mt-8 rounded-xl border border-sun-300 bg-sun-100 px-6 py-8 text-center"
        role="status"
        aria-live="assertive"
      >
        <div className="text-4xl" aria-hidden="true">&#127774;</div>
        <p className="mt-4 text-xl font-semibold text-sun-700">You did it!</p>
        <p className="mt-2 text-base text-ink-900">
          You can now: <span className="font-medium">{state.objective}</span>
        </p>
        <p className="mt-1 text-sm text-ink-600">Skill marked as demonstrated on your learning map.</p>
        <Link
          href={`/tracks/${trackId}`}
          className="mt-6 inline-block rounded-lg bg-sky-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Back to learning map
        </Link>
      </div>
    );
  }

  if (state.phase === 'failed') {
    return (
      <div
        data-testid="win-check-retry"
        ref={setMounted}
        className="mt-8 rounded-xl border border-ink-400/20 bg-cloud px-6 py-6"
        role="status"
        aria-live="polite"
      >
        <p className="text-base font-semibold text-ink-900">Almost there</p>
        <p className="mt-1 text-sm text-ink-600">
          Take a moment to review the lesson content above, then try the win-check again.
        </p>
        <button
          onClick={handleRetry}
          className="mt-4 rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          aria-label="Try win-check again"
        >
          Try again
        </button>
      </div>
    );
  }

  // Answering phase
  const currentItem = items[state.itemIndex];
  if (!currentItem) return null;

  return (
    <div
      data-testid="win-check"
      ref={setMounted}
      className="mt-8 rounded-xl border border-sun-300 bg-sun-100 px-6 py-6"
      aria-label="Win check — demonstrate what you learned"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-sun-700">Win check</p>
      <p className="mt-1 text-sm text-ink-600">
        Answer all questions correctly to complete this lesson.
      </p>
      {items.length > 1 && (
        <p className="mt-1 text-xs text-ink-400">
          {state.itemIndex + 1} of {items.length}
        </p>
      )}
      <p className="mt-4 text-base font-medium text-ink-900">{currentItem.question}</p>
      <div className="mt-4 flex flex-col gap-2">
        {currentItem.options.map((option, i) => {
          let btnClass =
            'rounded-lg border px-4 py-3 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sun-500';
          if (state.result !== null) {
            if (i === state.chosenIndex) {
              // Highlight the chosen option using the response: correct → sun, incorrect → red.
              // correctIndex is NOT available client-side (stripped from GET).
              btnClass += state.result.correct
                ? ' border-sun-500 bg-sun-300/40 text-ink-900 font-medium'
                : ' border-red-300 bg-red-50 text-red-700 font-medium';
            } else {
              btnClass += ' border-ink-400/20 bg-white text-ink-400 cursor-not-allowed';
            }
          } else {
            btnClass +=
              ' border-sun-300 bg-white text-ink-900 hover:border-sun-500 hover:bg-sun-100 disabled:cursor-not-allowed disabled:opacity-60';
          }
          return (
            <button
              key={i}
              data-testid={`quiz-option-${i}`}
              onClick={() => handleAnswer(currentItem, i)}
              disabled={state.submitting || state.result !== null}
              aria-label={`Option ${i + 1}: ${option}`}
              className={btnClass}
            >
              {option}
            </button>
          );
        })}
      </div>
      {state.result !== null && (
        <div
          className={`mt-4 rounded-lg px-4 py-3 text-sm ${
            state.result.correct
              ? 'bg-sky-100 border border-sky-300 text-sky-800'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}
        >
          <span className="font-medium">{state.result.correct ? 'Correct!' : 'Not quite.'}</span>{' '}
          {state.result.explanation}
        </div>
      )}
    </div>
  );
}
