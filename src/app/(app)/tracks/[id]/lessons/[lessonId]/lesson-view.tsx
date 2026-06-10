'use client';

import { useEffect, useRef, useState } from 'react';
import type { LessonBlock, QuizItem } from '@/server/lessons/blocks';
import type { LessonPlan } from '@/server/lessons/blocks';
import type { ProgressEvent, ProgressStage } from '@/workflows/generate-lesson';
import { ArticleSection } from '@/components/lesson/article-section';
import { GlossaryCallout } from '@/components/lesson/glossary-callout';
import { QuizBlock } from '@/components/lesson/quiz-block';
import { FlashcardDeck } from '@/components/lesson/flashcard-deck';
import { WorkedExample } from '@/components/lesson/worked-example';
import { AnimatedDiagram } from '@/components/lesson/animated-diagram';
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

const STAGE_MESSAGES: Record<ProgressStage, string> = {
  planned: 'Lesson planned — researching the topic…',
  researched: 'Research complete — writing your content…',
  generating: 'Writing your content…',
  ready: 'Almost ready…',
  failed: 'Something went wrong…',
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

// ── Outline-early: shown while status==='generating' and spec has content ────

type OutlineProps = { spec: Partial<LessonPlan> };
function LessonOutline({ spec }: OutlineProps) {
  if (!spec.objective && (!spec.blockOutline || spec.blockOutline.length === 0)) return null;
  return (
    <div data-testid="lesson-outline" className="mt-4 rounded-xl border border-sky-100 bg-sky-50/50 px-5 py-4">
      {spec.objective && (
        <p className="text-sm text-ink-700 mb-3">
          <span className="font-semibold text-sky-700">Goal:</span> {spec.objective}
        </p>
      )}
      {spec.blockOutline && spec.blockOutline.length > 0 && (
        <ol className="list-decimal list-inside space-y-1 text-sm text-ink-600">
          {spec.blockOutline.map((item, i) => (
            <li key={i} className="leading-snug capitalize">
              {item.focus}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── Generating spinner — display only ────────────────────────────────────────

type LessonGeneratingProps = { msgIndex: number; stage: ProgressStage | null; spec: Partial<LessonPlan> };
function LessonGenerating({ msgIndex, stage, spec }: LessonGeneratingProps) {
  const message = stage ? STAGE_MESSAGES[stage] : GENERATING_MESSAGES[msgIndex];
  const hasOutline = !!(spec.objective || (spec.blockOutline && spec.blockOutline.length > 0));
  return (
    <div>
      {hasOutline && <LessonOutline spec={spec} />}
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
        <p className="mt-4 text-base font-medium text-sky-700">{message}</p>
        <p className="mt-1 text-sm text-sky-600">This usually takes 30–90 seconds.</p>
      </div>
    </div>
  );
}

// ── Ready lesson renderer ────────────────────────────────────────────────────

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
        if (block.type === 'flashcard_deck') {
          return <FlashcardDeck key={idx} block={block} />;
        }
        if (block.type === 'worked_example') {
          return (
            <WorkedExample
              key={idx}
              lessonId={lessonId}
              block={block}
              liveRef={liveRef}
            />
          );
        }
        if (block.type === 'animated_diagram') {
          return <AnimatedDiagram key={idx} block={block} />;
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

// ── Failed lesson ────────────────────────────────────────────────────────────

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
      // so the stream/poll loop takes over. No router.refresh() needed here.
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

// ── Main exported component ──────────────────────────────────────────────────
//
// Owns the stream (preferred) with polling as fallback while status==='generating'.
// Stream consumption:
//   - On 'planned' event: refetch GET once to pick up spec (persisted by stagePlan).
//   - On 'ready'/'failed' events: fetch GET once → setData.
//   - On stream error/close-without-terminal: fall back to 2.5s polling.
// Polling is preserved as the unconditional fallback.
// Both are cleaned up on unmount/status transition.

export function LessonView({ lessonId, trackId }: Props) {
  const [data, setData] = useState<LessonData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msgIndex, setMsgIndex] = useState(0);
  const [stage, setStage] = useState<ProgressStage | null>(null);

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

  // Stream consumption + polling fallback while status === 'generating'.
  useEffect(() => {
    if (!data || data.status !== 'generating') return;

    let active = true;
    let abortController: AbortController | null = null;

    // Ticker for the fallback rotating message (used when stream is active too, as a
    // visual heartbeat, but stage message takes precedence in the render).
    const msgTimer = setInterval(() => {
      setMsgIndex((i) => (i + 1) % GENERATING_MESSAGES.length);
    }, 2500);

    // Helper: one GET fetch to refresh data from the server.
    async function refreshData() {
      try {
        const res = await fetch(`/api/lessons/${lessonId}`);
        if (!active || !res.ok) return;
        const json = (await res.json()) as LessonData;
        if (active) setData(json);
      } catch {
        // ignore transient errors
      }
    }

    // Start polling as the baseline; the stream may replace it as the primary update path.
    const pollTimer = setInterval(async () => {
      if (!active) return;
      try {
        const res = await fetch(`/api/lessons/${lessonId}`);
        if (!active || !res.ok) return;
        const json = (await res.json()) as LessonData;
        if (!active) return;
        if (json.status !== 'generating') {
          setData(json);
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2500);

    // Attempt to consume the stream — 409 (terminal) → skip; 404 (no runId yet) → polling only.
    async function consumeStream() {
      abortController = new AbortController();
      let res: Response;
      try {
        res = await fetch(`/api/lessons/${lessonId}/stream`, { signal: abortController.signal });
      } catch {
        return; // aborted or network error — polling takes over
      }
      if (!active) return;
      if (res.status === 409) {
        // Lesson is already terminal — do one final GET to pick up terminal state.
        await refreshData();
        return;
      }
      if (!res.ok || !res.body) return; // 404 (no runId) or other error — polling continues

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let receivedTerminal = false;

      try {
        while (active) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // The stream route encodes events as NDJSON (application/x-ndjson) — one JSON object per line.
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let event: ProgressEvent | null = null;
            try { event = JSON.parse(trimmed) as ProgressEvent; } catch { continue; }
            if (!active) break;
            setStage(event.stage);
            if (event.stage === 'planned') {
              // spec was persisted by stagePlan — refetch GET to pick it up.
              await refreshData();
            } else if (event.stage === 'ready' || event.stage === 'failed') {
              receivedTerminal = true;
              await refreshData();
            }
          }
          if (receivedTerminal) break;
        }
      } catch {
        // stream read error — polling continues as fallback
      } finally {
        try { reader.cancel(); } catch { /* ignore */ }
      }
    }

    consumeStream();

    return () => {
      active = false;
      clearInterval(msgTimer);
      clearInterval(pollTimer);
      // Abort any in-flight stream fetch (safe to call even if stream isn't active).
      if (abortController) {
        try { abortController.abort(); } catch { /* ignore */ }
      }
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
    return <LessonGenerating msgIndex={msgIndex} stage={stage} spec={data.spec ?? {}} />;
  }

  if (data.status === 'failed') {
    return (
      <LessonFailed
        lessonId={lessonId}
        trackId={trackId}
        reason={data.failureReason}
        onRetried={() => {
          setStage(null);
          setData({ status: 'generating', spec: data.spec ?? {} });
        }}
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
