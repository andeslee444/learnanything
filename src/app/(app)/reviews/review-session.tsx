'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';

// ── Types matching the GET /api/reviews/due response ─────────────────────────
type ReviewItemClient = {
  cardId: string;
  question: string;
  options: string[];
  // correctIndex is intentionally absent — server holds it
};

type GradeResponse = {
  correct: boolean;
  correctOption: string;
  explanation: string;
  nextDueInDays: number;
};

type Props = {
  initialItems: ReviewItemClient[];
};

// ── ReviewCard: renders one MC question ──────────────────────────────────────

type ReviewCardProps = {
  item: ReviewItemClient;
  /** Persistent aria-live ref from the parent */
  liveRef: React.RefObject<HTMLParagraphElement | null>;
  onGraded: (response: GradeResponse) => void;
};

function ReviewCard({ item, liveRef, onGraded }: ReviewCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<GradeResponse | null>(null);
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);
  const mountedRef = useRef(true);

  const setMountedNode = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      mountedRef.current = false;
    } else {
      mountedRef.current = true;
    }
  }, []);

  async function handleAnswer(answerIndex: number) {
    if (submitting || result !== null) return;
    setChosenIndex(answerIndex);
    setSubmitting(true);

    try {
      const res = await fetch(`/api/reviews/${item.cardId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answerIndex }),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        if (liveRef.current) {
          liveRef.current.textContent = 'Something went wrong — please try again.';
        }
        setSubmitting(false);
        setChosenIndex(null);
        return;
      }

      const data = (await res.json()) as GradeResponse;

      if (!mountedRef.current) return;

      setResult(data);
      setSubmitting(false);

      // Write warm feedback to the persistent aria-live region
      if (liveRef.current) {
        if (data.correct) {
          liveRef.current.textContent = `Nice — next review in ~${data.nextDueInDays} day${data.nextDueInDays === 1 ? '' : 's'}.`;
        } else {
          liveRef.current.textContent = `Not quite — the answer is: ${data.correctOption}`;
        }
      }

      onGraded(data);
    } catch {
      if (!mountedRef.current) return;
      setSubmitting(false);
      setChosenIndex(null);
      if (liveRef.current) {
        liveRef.current.textContent = 'Network error — please try again.';
      }
    }
  }

  return (
    <div
      ref={setMountedNode}
      data-testid="review-card"
      className="rounded-xl border border-sky-200 bg-sky-50 px-6 py-5"
    >
      <p className="text-base font-medium text-ink-900">{item.question}</p>

      <div className="mt-4 flex flex-col gap-2">
        {item.options.map((option, i) => {
          let btnClass =
            'rounded-lg border px-4 py-3 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400';

          if (result !== null) {
            // After grading: highlight chosen option using the response
            if (i === chosenIndex) {
              btnClass += result.correct
                ? ' border-sky-400 bg-sky-100 text-sky-800 font-medium'
                : ' border-red-300 bg-red-50 text-red-700 font-medium';
            } else if (option === result.correctOption && !result.correct) {
              // Show correct answer when wrong (warm, not harsh)
              btnClass += ' border-emerald-400 bg-emerald-50 text-emerald-800 font-medium';
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
              data-testid={`review-option-${i}`}
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

      {/* Inline feedback after answering */}
      {result !== null && (
        <div
          className={`mt-4 rounded-lg px-4 py-3 text-sm ${
            result.correct
              ? 'bg-sky-100 border border-sky-300 text-sky-800'
              : 'bg-amber-50 border border-amber-200 text-amber-800'
          }`}
        >
          {result.correct ? (
            <>
              <span className="font-medium">Nice!</span>{' '}
              Next review in ~{result.nextDueInDays} day{result.nextDueInDays === 1 ? '' : 's'}.
            </>
          ) : (
            <>
              <span className="font-medium">Not quite.</span>{' '}
              {result.explanation}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Done panel ────────────────────────────────────────────────────────────────

type DonePanelProps = {
  total: number;
  correct: number;
};

function DonePanel({ total, correct }: DonePanelProps) {
  return (
    <div
      data-testid="reviews-done"
      className="rounded-xl border border-sky-200 bg-sky-50 px-6 py-8 text-center"
    >
      <div className="text-4xl mb-3" aria-hidden="true">☀️</div>
      <p className="text-lg font-semibold text-ink-900">All done!</p>
      <p className="mt-2 text-sm text-ink-600">
        You answered {correct} of {total} correctly.
      </p>
      <Link
        href="/tracks"
        className="mt-5 inline-block rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        Back to learning
      </Link>
    </div>
  );
}

// ── Main exported session component ──────────────────────────────────────────

export function ReviewSession({ initialItems }: Props) {
  const [items] = useState<ReviewItemClient[]>(initialItems);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [showNext, setShowNext] = useState(false);
  const [finished, setFinished] = useState(initialItems.length === 0);
  const liveRef = useRef<HTMLParagraphElement | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleGraded(response: GradeResponse) {
    if (response.correct) setCorrectCount((c) => c + 1);

    const isLast = currentIndex === items.length - 1;
    if (isLast) {
      // Short delay so the user sees the feedback before done panel
      advanceTimerRef.current = setTimeout(() => {
        setFinished(true);
      }, 2000);
    } else {
      setShowNext(true);
    }
  }

  function handleNext() {
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    // Clear the live region before showing next card
    if (liveRef.current) liveRef.current.textContent = '';
    setCurrentIndex((i) => i + 1);
    setShowNext(false);
  }

  if (finished) {
    return <DonePanel total={items.length} correct={correctCount} />;
  }

  const currentItem = items[currentIndex];

  return (
    <div className="space-y-5">
      {/* Persistent aria-live region — always mounted, never conditional */}
      <p
        ref={liveRef}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />

      {/* Progress indicator */}
      <p className="text-xs text-sky-500 font-medium uppercase tracking-wide">
        {currentIndex + 1} / {items.length}
      </p>

      <ReviewCard
        key={currentItem.cardId}
        item={currentItem}
        liveRef={liveRef}
        onGraded={handleGraded}
      />

      {showNext && (
        <button
          onClick={handleNext}
          className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          aria-label="Next review card"
        >
          Next →
        </button>
      )}
    </div>
  );
}
