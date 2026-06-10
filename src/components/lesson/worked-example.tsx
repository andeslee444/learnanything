'use client';

import { useState, useRef, useCallback } from 'react';
import type { workedExampleSchema } from '@/server/lessons/blocks';
import type { z } from 'zod';

type WorkedExampleBlock = z.infer<typeof workedExampleSchema>;

type ItemResult = {
  correct: boolean;
  explanation: string;
  winCheck?: { answered: number; total: number; passed?: boolean };
};

type Props = {
  lessonId: string;
  block: WorkedExampleBlock;
  /** Persistent aria-live ref from the parent — we write feedback into it */
  liveRef: React.RefObject<HTMLParagraphElement | null>;
};

/**
 * WorkedExample block — walks the learner through a multi-step example then
 * gates completion behind a graded quiz item (completionItem).
 *
 * Step testids: we-step-{i} (0-indexed).
 * Completion option testids: we-option-{i} (DISTINCT from quiz-option-{i} — see Task 5).
 *
 * Grading is done server-side via the attempts API; correctIndex in the payload
 * is NOT used for client-side highlighting. Highlight is driven by the response
 * (correct boolean). NOTE: In Phase 4b the GET still returns correctIndex — it
 * will be stripped in Task 4. Matching quiz-block.tsx's pattern, we highlight
 * only from the response.
 */
export function WorkedExample({ lessonId, block, liveRef }: Props) {
  // revealedCount: how many steps are currently shown (0 = none; block.steps.length = all shown)
  const [revealedCount, setRevealedCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ItemResult | null>(null);
  // Track which option index was chosen so we can highlight it from the response.
  // correctIndex is NOT used client-side (will be stripped from GET in Task 4).
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const setMounted = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      mountedRef.current = false;
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    } else {
      mountedRef.current = true;
    }
  }, []);

  const allStepsRevealed = revealedCount >= block.steps.length;
  const completionItem = block.completionItem;

  function handleRevealNext() {
    setRevealedCount((n) => Math.min(n + 1, block.steps.length));
  }

  async function handleAnswer(answerIndex: number) {
    if (submitting || result !== null) return;
    setChosenIndex(answerIndex);
    setSubmitting(true);

    try {
      const res = await fetch(`/api/lessons/${lessonId}/attempts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: completionItem.id, answerIndex, kind: 'quiz' }),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        if (liveRef.current) liveRef.current.textContent = 'Something went wrong — please try again.';
        setSubmitting(false);
        return;
      }

      const data = (await res.json()) as ItemResult;
      setResult(data);
      setSubmitting(false);

      // Write feedback to the persistent live region
      if (liveRef.current) {
        liveRef.current.textContent = data.correct
          ? `Correct! ${data.explanation}`
          : `Not quite. ${data.explanation}`;
      }
    } catch {
      if (!mountedRef.current) return;
      setSubmitting(false);
      if (liveRef.current) liveRef.current.textContent = 'Network error — please try again.';
    }
  }

  return (
    <div
      ref={setMounted}
      data-testid="worked-example"
      className="mt-6 rounded-xl border border-sky-200 bg-sky-50 px-6 py-5"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-sky-500 mb-3">Worked example</p>

      {/* Problem statement */}
      <p className="text-base font-medium text-ink-900 mb-4">{block.problem}</p>

      {/* Revealed steps */}
      <ol className="space-y-3 mb-4">
        {block.steps.slice(0, revealedCount).map((step, i) => (
          <li
            key={i}
            data-testid={`we-step-${i}`}
            className="flex gap-3 rounded-lg border border-sky-200 bg-white px-4 py-3"
          >
            <span className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-sky-100 text-xs font-semibold text-sky-600">
              {i + 1}
            </span>
            <span className="text-sm text-ink-900">{step.text}</span>
          </li>
        ))}
      </ol>

      {/* Reveal next step button */}
      {!allStepsRevealed && (
        <button
          data-testid="we-show-next-step"
          onClick={handleRevealNext}
          className="mb-4 rounded-lg border border-sky-200 bg-white px-4 py-2 text-sm text-sky-600 hover:border-sky-400 hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Show next step
        </button>
      )}

      {/* Completion quiz item — shown only after all steps are revealed */}
      {allStepsRevealed && (
        <div className="mt-4 rounded-xl border border-sky-300 bg-white px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-sky-500 mb-2">Check your understanding</p>
          <p className="text-base font-medium text-ink-900">{completionItem.question}</p>
          <div className="mt-3 flex flex-col gap-2">
            {completionItem.options.map((option, i) => {
              let btnClass =
                'rounded-lg border px-4 py-3 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400';
              if (result !== null) {
                if (i === chosenIndex) {
                  // Highlight the chosen option using the response: correct → sky, incorrect → red.
                  // correctIndex is NOT used client-side (will be stripped from GET in Task 4).
                  btnClass += result.correct
                    ? ' border-sky-400 bg-sky-100 text-sky-800 font-medium'
                    : ' border-red-300 bg-red-50 text-red-700 font-medium';
                } else {
                  btnClass += ' border-ink-400/20 bg-white text-ink-400 cursor-not-allowed';
                }
              } else {
                btnClass +=
                  ' border-sky-200 bg-white text-ink-900 hover:border-sky-400 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-60';
              }
              return (
                <button
                  key={i}
                  data-testid={`we-option-${i}`}
                  onClick={() => handleAnswer(i)}
                  disabled={submitting || result !== null}
                  aria-label={`Option ${i + 1}: ${option}`}
                  className={btnClass}
                >
                  {option}
                </button>
              );
            })}
          </div>
          {result !== null && (
            <div
              className={`mt-4 rounded-lg px-4 py-3 text-sm ${
                result.correct
                  ? 'bg-sky-100 border border-sky-300 text-sky-800'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}
            >
              <span className="font-medium">{result.correct ? 'Correct!' : 'Not quite.'}</span>{' '}
              {result.explanation}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
