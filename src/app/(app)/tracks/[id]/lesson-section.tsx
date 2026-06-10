'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type LessonCard = {
  id: string;
  seq: number;
  status: string;
  objective: string | null;
};

type Props = {
  trackId: string;
  lessons: LessonCard[];
  hasNodes: boolean;
};

type StartState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'credits_error' }
  | { kind: 'already_generating' }
  | { kind: 'error'; message: string };

const STATUS_LABELS: Record<string, string> = {
  generating: 'Generating…',
  ready: 'Ready',
  failed: 'Failed',
  queued: 'Queued',
  needs_review: 'Needs review',
};

const STATUS_CLASSES: Record<string, string> = {
  generating: 'bg-sky-100 text-sky-700',
  ready: 'bg-sky-200 text-sky-800',
  failed: 'bg-red-100 text-red-700',
  queued: 'bg-ink-400/10 text-ink-600',
  needs_review: 'bg-sun-100 text-sun-700',
};

export function LessonSection({ trackId, lessons, hasNodes }: Props) {
  const router = useRouter();
  const [startState, setStartState] = useState<StartState>({ kind: 'idle' });

  const hasGenerating = lessons.some((l) => l.status === 'generating');
  const showStartButton = hasNodes && !hasGenerating;

  async function handleStart() {
    if (startState.kind === 'starting' || startState.kind === 'already_generating') return;
    setStartState({ kind: 'starting' });

    try {
      const res = await fetch(`/api/tracks/${trackId}/lessons`, { method: 'POST' });

      if (res.status === 402) {
        setStartState({ kind: 'credits_error' });
        return;
      }
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string };
        if (body.error === 'already_generating') {
          setStartState({ kind: 'already_generating' });
          return;
        }
        setStartState({ kind: 'error', message: 'Track must be initialized before starting a lesson.' });
        return;
      }
      if (!res.ok) {
        setStartState({ kind: 'error', message: 'Something went wrong — please try again.' });
        return;
      }

      const { lessonId } = (await res.json()) as { lessonId: string };
      router.push(`/tracks/${trackId}/lessons/${lessonId}`);
    } catch {
      setStartState({ kind: 'error', message: 'Network error — please check your connection.' });
    }
  }

  return (
    <section className="mt-8" aria-label="Lessons">
      <h2 className="text-lg font-medium text-ink-900">Lessons</h2>

      {/* Lesson cards list */}
      {lessons.length > 0 ? (
        <div className="mt-3 flex flex-col gap-3">
          {lessons.map((lesson) => (
            <div
              key={lesson.id}
              data-testid="lesson-card"
              className="flex items-center justify-between rounded-xl border border-ink-400/20 bg-cloud px-5 py-3 shadow-sm"
            >
              <div>
                <p className="text-sm font-medium text-ink-900">
                  Lesson {lesson.seq}
                  {lesson.objective && (
                    <span className="ml-2 font-normal text-ink-600">— {lesson.objective}</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[lesson.status] ?? 'bg-ink-400/10 text-ink-600'}`}
                  aria-label={`Status: ${STATUS_LABELS[lesson.status] ?? lesson.status}`}
                >
                  {STATUS_LABELS[lesson.status] ?? lesson.status}
                </span>
                {(lesson.status === 'ready' || lesson.status === 'generating' || lesson.status === 'failed') && (
                  <Link
                    href={`/tracks/${trackId}/lessons/${lesson.id}`}
                    className="text-xs text-sky-600 hover:text-sky-700 underline underline-offset-2"
                    aria-label={`Open lesson ${lesson.seq}`}
                  >
                    {lesson.status === 'generating' ? 'View' : lesson.status === 'failed' ? 'Retry' : 'Open'}
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-600">No lessons yet — start your first one below.</p>
      )}

      {/* Credits notice */}
      {startState.kind === 'credits_error' && (
        <div
          data-testid="credits-notice"
          className="mt-4 rounded-xl border border-sun-300 bg-sun-100 px-5 py-3"
          role="alert"
        >
          <p className="text-sm text-sun-700 font-medium">Out of credits this month</p>
          <p className="mt-1 text-xs text-ink-600">Your monthly lesson credits will renew at the start of next month.</p>
        </div>
      )}

      {/* Already generating notice */}
      {(startState.kind === 'already_generating' || hasGenerating) && (
        <p className="mt-3 text-sm text-sky-600">
          A lesson is already being prepared — check back soon.
        </p>
      )}

      {/* General error */}
      {startState.kind === 'error' && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {startState.message}
        </p>
      )}

      {/* Start lesson button */}
      {showStartButton && (
        <button
          data-testid="start-lesson"
          onClick={handleStart}
          disabled={startState.kind === 'starting' || startState.kind === 'already_generating'}
          className="mt-4 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          aria-label="Start a new lesson"
        >
          {startState.kind === 'starting' ? 'Starting…' : 'Start lesson'}
        </button>
      )}

      {/* Disabled state when generating */}
      {!showStartButton && hasNodes && hasGenerating && (
        <button
          data-testid="start-lesson"
          disabled
          className="mt-4 rounded-lg bg-sky-200 px-5 py-2.5 text-sm font-medium text-sky-500 cursor-not-allowed"
          aria-label="A lesson is already being prepared"
          aria-disabled="true"
        >
          A lesson is being prepared…
        </button>
      )}
    </section>
  );
}
