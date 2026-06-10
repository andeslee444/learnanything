'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CalibrationQuiz } from '@/server/track-init';

const BUILD_MESSAGES = [
  'Reading your mission…',
  'Mapping the skills…',
  'Ordering the steps…',
  'Almost there…',
];

type Props = {
  trackId: string;
  mode: 'build' | 'calibrate';
};

type QuizState = {
  quiz: CalibrationQuiz;
  itemIndex: number;
  answered: boolean;
  lastCorrect: boolean | null;
  submitting: boolean;
};

// All hooks and logic live here; only rendered for mode='build'.
function TrackBuildSetup({ trackId }: { trackId: string }) {
  const router = useRouter();
  const firedRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const [msgIndex, setMsgIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitMsg, setWaitMsg] = useState(false);
  const [quizState, setQuizState] = useState<QuizState | null>(null);

  // Clear the advance timer and mark unmounted on cleanup.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
    };
  }, []);

  // When quiz is fully completed (itemIndex past the last item), refresh to show the map.
  useEffect(() => {
    if (!quizState) return;
    if (quizState.itemIndex >= quizState.quiz.items.length) {
      router.refresh();
    }
  }, [quizState, router]);

  // mode='build': fire initialize on mount (guarded with useRef to prevent double-fire)
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    setPending(true);
    setError(null);

    // Start cycling messages
    intervalRef.current = setInterval(() => {
      setMsgIndex((i) => (i + 1) % BUILD_MESSAGES.length);
    }, 2500);

    postInitialize();

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function postInitialize() {
    try {
      const res = await fetch(`/api/tracks/${trackId}/initialize`, { method: 'POST' });

      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (!mountedRef.current) return;
      setPending(false);

      if (res.status === 429) {
        setWaitMsg(true);
        setError("Still working on a previous attempt — give it a minute.");
        return;
      }

      if (!res.ok) {
        setError("Something went wrong building your learning map. Please try again.");
        return;
      }

      const data = await res.json() as
        | { status: 'initialized'; quiz: CalibrationQuiz | null }
        | { status: 'already_initialized' };

      if (data.status === 'already_initialized') {
        router.refresh();
        return;
      }

      // status === 'initialized'
      if (data.quiz && data.quiz.items.length > 0) {
        setQuizState({
          quiz: data.quiz,
          itemIndex: 0,
          answered: false,
          lastCorrect: null,
          submitting: false,
        });
      } else {
        // quiz is null (generation failed server-side) — graph is ready
        router.refresh();
      }
    } catch {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (!mountedRef.current) return;
      setPending(false);
      setError("Network error — please check your connection and try again.");
    }
  }

  function handleRetry() {
    firedRef.current = false;
    setError(null);
    setWaitMsg(false);
    setPending(true);
    setMsgIndex(0);

    intervalRef.current = setInterval(() => {
      setMsgIndex((i) => (i + 1) % BUILD_MESSAGES.length);
    }, 2500);

    postInitialize();
  }

  async function handleAnswer(item: CalibrationQuiz['items'][number], answerIndex: number) {
    if (!quizState || quizState.submitting) return;

    setQuizState((prev) => prev ? { ...prev, submitting: true } : null);

    try {
      await fetch(`/api/tracks/${trackId}/calibration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item, answerIndex }),
      });
    } catch {
      // best-effort; calibration is raw signal — proceed even on network failure
    }

    if (!mountedRef.current) return;

    const correct = answerIndex === item.correctIndex;
    setQuizState((prev) => prev ? { ...prev, answered: true, lastCorrect: correct, submitting: false } : null);

    // Auto-advance after ~800ms
    advanceTimerRef.current = setTimeout(() => {
      advanceTimerRef.current = null;
      if (!mountedRef.current) return;
      setQuizState((prev) => {
        if (!prev) return null;
        const next = prev.itemIndex + 1;
        if (next >= prev.quiz.items.length) {
          // All items done — signal completion (router.refresh() called in useEffect below)
          return { ...prev, itemIndex: next, answered: false, lastCorrect: null };
        }
        return { ...prev, itemIndex: next, answered: false, lastCorrect: null };
      });
    }, 800);
  }

  // Pending / building state
  if (pending) {
    return (
      <div
        data-testid="build-status"
        className="mt-8 rounded-xl border border-sky-200 bg-sky-50 px-6 py-8 text-center"
        aria-live="polite"
        aria-label="Building your learning map"
      >
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-sky-300 border-t-sky-600" aria-hidden="true" />
        <p className="mt-4 text-base font-medium text-sky-700">{BUILD_MESSAGES[msgIndex]}</p>
        <p className="mt-1 text-sm text-sky-600">This usually takes 20–60 seconds.</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="mt-8 rounded-xl border border-red-200 bg-red-50 px-6 py-6">
        <p role="alert" className="text-base font-medium text-red-700">{error}</p>
        <button
          data-testid="build-retry"
          onClick={handleRetry}
          className="mt-4 rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700"
        >
          Try again
        </button>
        {waitMsg && (
          <p className="mt-3 text-sm text-ink-600">
            Your previous map generation is still running. Wait a minute before retrying.
          </p>
        )}
      </div>
    );
  }

  // Quiz state
  if (quizState) {
    const { quiz, itemIndex, answered, lastCorrect, submitting } = quizState;
    const item = quiz.items[itemIndex];
    const total = quiz.items.length;

    // itemIndex past end means all items done; useEffect will call router.refresh()
    if (!item) return null;

    return (
      <div className="mt-8 rounded-xl border border-sky-200 bg-sky-50 px-6 py-8">
        <p className="text-xs font-medium uppercase tracking-wide text-sky-500">
          Quick placement check — no wrong answers here
        </p>
        <p className="mt-1 text-sm text-sky-600">
          Question {itemIndex + 1} of {total}
        </p>
        <h3 className="mt-4 text-base font-medium text-ink-900">{item.question}</h3>
        <div className="mt-4 flex flex-col gap-2">
          {item.options.map((option, i) => (
            <button
              key={i}
              data-testid={`quiz-option-${i}`}
              onClick={() => handleAnswer(item, i)}
              disabled={answered || submitting}
              className="rounded-lg border border-sky-200 bg-white px-4 py-3 text-left text-sm text-ink-900 transition hover:border-sky-400 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={`Option ${i + 1}: ${option}`}
            >
              {option}
            </button>
          ))}
        </div>
        {/* Persistent live region — always rendered so screen readers pick up changes */}
        <p aria-live="polite" className="mt-4 text-sm font-medium text-sky-700">
          {answered && lastCorrect !== null
            ? (lastCorrect ? 'Nice!' : "Good to know — we'll start there.")
            : ''}
        </p>
      </div>
    );
  }

  return null;
}

// Thin public wrapper — calibrate mode returns null early without touching any hooks.
export function TrackSetup({ trackId, mode }: Props) {
  if (mode === 'calibrate') return null;
  return <TrackBuildSetup trackId={trackId} />;
}
