'use client';

import { useEffect, useRef, useState } from 'react';
import type { LessonBlock, QuizItem } from '@/server/lessons/blocks';
import type { LessonPlan } from '@/server/lessons/blocks';
import { ArticleSection } from '@/components/lesson/article-section';
import { GlossaryCallout } from '@/components/lesson/glossary-callout';
import { QuizBlock } from '@/components/lesson/quiz-block';
import { WinCheck } from '@/components/lesson/win-check';

type LessonContent = {
  openerItems: QuizItem[];
  blocks: LessonBlock[];
  winCheck: { items: QuizItem[] };
};

type LessonData = {
  status: string;
  spec: Partial<LessonPlan>;
  content?: LessonContent;
  citations?: Array<{ url: string }>;
  failureReason?: string;
};

const GENERATING_MESSAGES = [
  'Planning your lesson…',
  'Researching the topic…',
  'Writing your content…',
  'Putting it all together…',
  'Almost ready…',
];

type Props = {
  lessonId: string;
  trackId: string;
};

// Generating spinner — display only. Polling is owned by LessonView.
type LessonGeneratingProps = { msgIndex: number };
function LessonGenerating({ msgIndex }: LessonGeneratingProps) {
  return (
    <div
      data-testid="lesson-generating"
      className="mt-8 rounded-xl border border-sky-200 bg-sky-50 px-6 py-10 text-center"
      aria-live="polite"
      aria-label="Lesson is being generated"
    >
      <div
        className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-sky-300 border-t-sky-600"
        aria-hidden="true"
      />
      <p className="mt-4 text-base font-medium text-sky-700">{GENERATING_MESSAGES[msgIndex]}</p>
      <p className="mt-1 text-sm text-sky-600">This usually takes 30–90 seconds.</p>
    </div>
  );
}

type LessonReadyProps = Props & {
  data: LessonData;
};

function LessonReady({ lessonId, trackId, data }: LessonReadyProps) {
  const liveRef = useRef<HTMLParagraphElement | null>(null);
  const [openerComplete, setOpenerComplete] = useState(false);
  const objective = data.spec?.objective ?? 'complete this skill';

  const content = data.content!;
  const openerItems = content.openerItems ?? [];
  const blocks = content.blocks ?? [];
  const winCheckItems = content.winCheck?.items ?? [];

  // Show win-check only after opener items (if any) are done.
  const showBlocks = openerItems.length === 0 || openerComplete;

  return (
    <article className="mt-6">
      {/* Persistent aria-live region — always rendered, never conditionally mounted */}
      <p
        ref={liveRef}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />

      {/* Objective */}
      {data.spec?.objective && (
        <p className="text-sm text-ink-600 mb-4">
          <span className="font-medium">Goal:</span> {data.spec.objective}
        </p>
      )}

      {/* Opener: quick recall from glossary */}
      {openerItems.length > 0 && !openerComplete && (
        <QuizBlock
          lessonId={lessonId}
          items={openerItems}
          kind="opener"
          label="Quick recall — warm up your memory"
          liveRef={liveRef}
          onComplete={() => setOpenerComplete(true)}
        />
      )}

      {/* Main blocks */}
      {showBlocks && blocks.map((block, idx) => {
        if (block.type === 'article') {
          return <ArticleSection key={idx} block={block} />;
        }
        if (block.type === 'glossary_callout') {
          return <GlossaryCallout key={idx} block={block} />;
        }
        if (block.type === 'quiz') {
          return (
            <QuizBlock
              key={idx}
              lessonId={lessonId}
              items={block.items}
              kind="quiz"
              liveRef={liveRef}
            />
          );
        }
        return null;
      })}

      {/* Win check */}
      {showBlocks && winCheckItems.length > 0 && (
        <WinCheck
          lessonId={lessonId}
          items={winCheckItems}
          objective={objective}
          trackId={trackId}
          liveRef={liveRef}
        />
      )}
    </article>
  );
}

type LessonFailedProps = Props & {
  reason?: string;
  onRetried: () => void;
};

function LessonFailed({ lessonId, reason, onRetried }: LessonFailedProps) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const res = await fetch(`/api/lessons/${lessonId}/retry`, { method: 'POST' });
      if (res.status === 402) {
        setError('out of credits this month — please wait for your next monthly grant');
        setRetrying(false);
        return;
      }
      if (!res.ok) {
        setError('Could not retry — please try again shortly.');
        setRetrying(false);
        return;
      }
      // Retry started — hand off to LessonView by transitioning to 'generating'
      // so the existing poll loop takes over. No router.refresh() needed here.
      onRetried();
    } catch {
      setError('Network error — please check your connection.');
      setRetrying(false);
    }
  }

  return (
    <div
      className="mt-8 rounded-xl border border-red-200 bg-red-50 px-6 py-6"
      role="alert"
    >
      <p className="text-base font-semibold text-red-700">Lesson generation failed</p>
      {reason && <p className="mt-1 text-sm text-red-600">{String(reason)}</p>}
      {error && (
        <p className="mt-2 text-sm font-medium text-red-800">{error}</p>
      )}
      <button
        data-testid="lesson-retry"
        onClick={handleRetry}
        disabled={retrying}
        className="mt-4 rounded-lg bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        aria-label="Retry lesson generation"
      >
        {retrying ? 'Retrying…' : 'Try again'}
      </button>
    </div>
  );
}

// Main exported component — owns the poll interval while status==='generating'.
// The interval is cleared as soon as setData transitions to a non-generating status
// (or on unmount), so no stale polling continues after the lesson is ready.
export function LessonView({ lessonId, trackId }: Props) {
  const [data, setData] = useState<LessonData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msgIndex, setMsgIndex] = useState(0);

  // Initial fetch
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch(`/api/lessons/${lessonId}`);
        if (!active) return;
        if (!res.ok) {
          setLoadError('Failed to load lesson — please refresh.');
          return;
        }
        const json = (await res.json()) as LessonData;
        if (active) setData(json);
      } catch {
        if (!active) return;
        setLoadError('Network error — please check your connection.');
      }
    }
    load();
    return () => { active = false; };
  }, [lessonId]);

  // Poll only while status === 'generating'. Interval is cleared when status
  // transitions to ready/failed (setData called) or when the component unmounts.
  useEffect(() => {
    if (!data || data.status !== 'generating') return;

    let active = true;

    const msgTimer = setInterval(() => {
      setMsgIndex((i) => (i + 1) % GENERATING_MESSAGES.length);
    }, 2500);

    const pollTimer = setInterval(async () => {
      if (!active) return;
      try {
        const res = await fetch(`/api/lessons/${lessonId}`);
        if (!active || !res.ok) return;
        const json = (await res.json()) as LessonData;
        if (!active) return;
        if (json.status !== 'generating') {
          // Transition out — setData will cause a re-render; this effect will
          // not re-run for 'generating' so both intervals are cleaned up below.
          setData(json);
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2500);

    return () => {
      active = false;
      clearInterval(msgTimer);
      clearInterval(pollTimer);
    };
  }, [lessonId, data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) {
    return (
      <div className="mt-8 rounded-xl border border-red-200 bg-red-50 px-6 py-4" role="alert">
        <p className="text-sm text-red-700">{loadError}</p>
      </div>
    );
  }

  if (!data) {
    // Initial skeleton
    return (
      <div className="mt-8 animate-pulse space-y-4">
        <div className="h-6 w-2/3 rounded bg-ink-400/10" />
        <div className="h-4 w-full rounded bg-ink-400/10" />
        <div className="h-4 w-5/6 rounded bg-ink-400/10" />
      </div>
    );
  }

  if (data.status === 'generating') {
    return <LessonGenerating msgIndex={msgIndex} />;
  }

  if (data.status === 'failed') {
    return (
      <LessonFailed
        lessonId={lessonId}
        trackId={trackId}
        reason={data.failureReason}
        onRetried={() => setData({ status: 'generating', spec: data.spec ?? {} })}
      />
    );
  }

  if (data.status === 'ready' && data.content) {
    return <LessonReady lessonId={lessonId} trackId={trackId} data={data} />;
  }

  return (
    <div className="mt-8 rounded-xl bg-sky-50 px-5 py-4 text-sky-700">
      <p>Lesson status: {data.status}</p>
    </div>
  );
}
