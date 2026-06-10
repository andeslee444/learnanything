'use client';

import { useState, useRef, useCallback } from 'react';
import type { QuizItem } from '@/server/lessons/blocks';

type Kind = 'opener' | 'quiz' | 'win_check';

type ItemResult = {
  correct: boolean;
  explanation: string;
  winCheck?: { answered: number; total: number; passed?: boolean };
};

type Props = {
  lessonId: string;
  items: QuizItem[];
  kind: Kind;
  label?: string;
  /** Called after each item is answered; for win_check items passes the winCheck result */
  onItemAnswered?: (result: ItemResult, item: QuizItem) => void;
  /** Called when all items in this block have been answered */
  onComplete?: () => void;
  /** Persistent aria-live ref from the parent — we write feedback into it */
  liveRef: React.RefObject<HTMLParagraphElement | null>;
};

export function QuizBlock({ lessonId, items, kind, label, onItemAnswered, onComplete, liveRef }: Props) {
  const [itemIndex, setItemIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ItemResult | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Cleanup on unmount
  const setMounted = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      mountedRef.current = false;
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    }
  }, []);

  const currentItem = items[itemIndex];
  const isLastItem = itemIndex === items.length - 1;

  async function handleAnswer(item: QuizItem, answerIndex: number) {
    if (submitting || result !== null) return;
    setSubmitting(true);

    try {
      const res = await fetch(`/api/lessons/${lessonId}/attempts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, answerIndex, kind }),
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

      onItemAnswered?.(data, item);

      // Auto-advance to next item after a brief delay (unless last item)
      if (!isLastItem) {
        advanceTimerRef.current = setTimeout(() => {
          advanceTimerRef.current = null;
          if (!mountedRef.current) return;
          setItemIndex((i) => i + 1);
          setResult(null);
          if (liveRef.current) liveRef.current.textContent = '';
        }, 1800);
      } else {
        // Last item answered — notify parent
        advanceTimerRef.current = setTimeout(() => {
          advanceTimerRef.current = null;
          if (!mountedRef.current) return;
          onComplete?.();
        }, 1800);
      }
    } catch {
      if (!mountedRef.current) return;
      setSubmitting(false);
      if (liveRef.current) liveRef.current.textContent = 'Network error — please try again.';
    }
  }

  if (!currentItem) return null;

  return (
    <div ref={setMounted} className="mt-6 rounded-xl border border-sky-200 bg-sky-50 px-6 py-5">
      {label && (
        <p className="text-xs font-medium uppercase tracking-wide text-sky-500 mb-3">{label}</p>
      )}
      {items.length > 1 && (
        <p className="text-xs text-sky-400 mb-2">
          {itemIndex + 1} / {items.length}
        </p>
      )}
      <p className="text-base font-medium text-ink-900">{currentItem.question}</p>
      <div className="mt-4 flex flex-col gap-2">
        {currentItem.options.map((option, i) => {
          let btnClass =
            'rounded-lg border px-4 py-3 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400';
          if (result !== null) {
            if (i === currentItem.correctIndex) {
              btnClass += ' border-sky-400 bg-sky-100 text-sky-800 font-medium';
            } else if (result !== null) {
              btnClass += ' border-ink-400/20 bg-white text-ink-400 cursor-not-allowed';
            }
          } else {
            btnClass +=
              ' border-sky-200 bg-white text-ink-900 hover:border-sky-400 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-60';
          }
          return (
            <button
              key={i}
              data-testid={`quiz-option-${i}`}
              onClick={() => handleAnswer(currentItem, i)}
              disabled={submitting || result !== null}
              aria-label={`Option ${i + 1}: ${option}`}
              className={btnClass}
            >
              {option}
            </button>
          );
        })}
      </div>
      {/* Inline explanation shown after answering */}
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
  );
}
