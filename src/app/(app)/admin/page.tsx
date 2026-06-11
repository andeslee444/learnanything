'use client';

/**
 * /admin — Founder review queue.
 *
 * Section 1: Lessons flagged for safety, low faithfulness, or verification issues.
 * Section 2: Shared lessons with report_count >= 1 OR moderationStatus = 'pending'.
 *
 * Gated by ADMIN_EMAILS; non-admin users hit the API and receive 404 — the page
 * surfaces that as "not found" without revealing the route exists.
 *
 * Client component so all actions use fetch without a full page reload.
 */

import { useEffect, useState } from 'react';

interface QueueItem {
  id: string;
  status: string;
  verificationStatus: string;
  faithfulnessScore: number | null;
  content: Record<string, unknown> | null;
  createdAt: string;
  topic: string;
  displayName: string;
}

interface SharedQueueItem {
  id: string;
  slug: string;
  vertical: string;
  moderationStatus: string;
  reportCount: number;
  createdAt: string;
  topic: string;
}

type ActionState = 'idle' | 'loading' | 'done' | 'error';

export default function AdminPage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [sharedItems, setSharedItems] = useState<SharedQueueItem[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});

  // Initial load: fetch the queue and update state.
  // setState calls are in .then()/.catch() callbacks — allowed by react-hooks/set-state-in-effect.
  // The rule only disallows synchronous setState calls in the effect body itself.
  useEffect(() => {
    fetch('/api/admin/queue')
      .then(async (res) => {
        if (res.status === 404) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        const data = await res.json() as { items: QueueItem[]; sharedItems: SharedQueueItem[] };
        setItems(data.items ?? []);
        setSharedItems(data.sharedItems ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function handleAction(lessonId: string, action: 'retry' | 'dismiss') {
    setActionStates((s) => ({ ...s, [lessonId]: 'loading' }));
    const res = await fetch('/api/admin/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId, action }),
    });
    if (!res.ok) {
      setActionStates((s) => ({ ...s, [lessonId]: 'error' }));
      return;
    }
    setActionStates((s) => ({ ...s, [lessonId]: 'done' }));
    // Remove the item from the list immediately (dismiss) or mark retried (retry).
    setItems((prev) =>
      action === 'dismiss'
        ? prev.filter((i) => i.id !== lessonId)
        : prev.map((i) => i.id === lessonId ? { ...i, status: 'generating' } : i),
    );
  }

  async function handleSharedAction(sharedLessonId: string, action: 'republish' | 'take_down') {
    setActionStates((s) => ({ ...s, [sharedLessonId]: 'loading' }));
    const res = await fetch('/api/admin/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLessonId, action }),
    });
    if (!res.ok) {
      setActionStates((s) => ({ ...s, [sharedLessonId]: 'error' }));
      return;
    }
    setActionStates((s) => ({ ...s, [sharedLessonId]: 'done' }));
    // Update the item's moderationStatus in-place.
    setSharedItems((prev) =>
      prev.map((i) =>
        i.id === sharedLessonId
          ? {
              ...i,
              moderationStatus: action === 'republish' ? 'approved' : 'removed',
              reportCount: action === 'republish' ? 0 : i.reportCount,
            }
          : i,
      ),
    );
  }

  if (notFound) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
        <p className="text-ink-400 text-sm">Not found.</p>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-xl font-semibold text-ink-900">Admin — review queue</h1>
        <p className="mt-4 text-sm text-ink-400">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-xl font-semibold text-ink-900">Admin — review queue</h1>

      {/* ── Section 1: Lesson flags ─────────────────────────────────────────── */}
      <h2 className="mt-8 text-base font-semibold text-ink-700">Lesson flags</h2>
      <p className="mt-1 text-sm text-ink-400">
        Lessons flagged for safety, low faithfulness, or verification issues. Newest 50.
      </p>

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-ink-400">Queue is empty — all clear.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-ink-400/20">
          <table className="min-w-full text-sm">
            <thead className="bg-cloud border-b border-ink-400/20">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Learner</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Topic</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Status</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Verification</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Faithfulness</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Reason</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-400/10">
              {items.map((item) => {
                const failureReason =
                  item.content && typeof item.content === 'object' && 'failureReason' in item.content
                    ? String(item.content.failureReason)
                    : '—';
                const state = actionStates[item.id] ?? 'idle';
                return (
                  <tr key={item.id} data-testid="admin-queue-row" className="bg-white hover:bg-sky-50">
                    <td className="px-4 py-3 text-ink-700">{item.displayName}</td>
                    <td className="px-4 py-3 text-ink-700 max-w-[180px] truncate">{item.topic}</td>
                    <td className="px-4 py-3">
                      {/* sun-700 (#8c5e0a) on sun-100 (#fff3d6): 4.97:1 — passes WCAG AA. */}
                      <span className="rounded-full bg-sun-100 px-2 py-0.5 text-sm font-semibold text-sun-700 capitalize">
                        {item.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                        item.verificationStatus === 'issues'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-ink-100 text-ink-600'
                      }`}>
                        {item.verificationStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-600">
                      {item.faithfulnessScore != null
                        ? item.faithfulnessScore.toFixed(2)
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-ink-500 max-w-[200px] truncate" title={failureReason}>
                      {failureReason}
                    </td>
                    <td className="px-4 py-3">
                      {state === 'loading' ? (
                        <span className="text-xs text-ink-400">Working…</span>
                      ) : state === 'error' ? (
                        <span className="text-xs text-red-500">Error — try again</span>
                      ) : item.status === 'generating' ? (
                        <span className="text-xs text-sky-600">Retrying…</span>
                      ) : (
                        <div className="flex gap-2">
                          {item.status === 'failed' && (
                            <button
                              type="button"
                              onClick={() => handleAction(item.id, 'retry')}
                              className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                              aria-label={`Retry lesson for ${item.displayName}`}
                            >
                              Retry
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleAction(item.id, 'dismiss')}
                            className="rounded-lg border border-ink-400/30 px-3 py-1 text-xs font-medium text-ink-600 hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                            aria-label={`Dismiss lesson for ${item.displayName}`}
                          >
                            Dismiss
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Section 2: Shared lesson reports ──────────────────────────────────── */}
      <h2 className="mt-10 text-base font-semibold text-ink-700">Shared lesson reports</h2>
      <p className="mt-1 text-sm text-ink-400">
        Shared lessons with 1+ reports or pending review. Newest 50.
      </p>

      {sharedItems.length === 0 ? (
        <p className="mt-4 text-sm text-ink-400">No reported or pending shared lessons.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-ink-400/20">
          <table className="min-w-full text-sm">
            <thead className="bg-cloud border-b border-ink-400/20">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Topic</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Slug</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Status</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Reports</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-ink-400 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-400/10">
              {sharedItems.map((item) => {
                const state = actionStates[item.id] ?? 'idle';
                return (
                  <tr key={item.id} data-testid="admin-shared-row" className="bg-white hover:bg-sky-50">
                    <td className="px-4 py-3 text-ink-700 max-w-[180px] truncate">{item.topic}</td>
                    <td className="px-4 py-3 text-ink-600 max-w-[200px] truncate">
                      <a
                        href={`/learn/${item.vertical}/${item.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sky-600 hover:underline"
                      >
                        {item.slug}
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                        item.moderationStatus === 'approved'
                          ? 'bg-sky-100 text-sky-700'
                          : item.moderationStatus === 'removed'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-sun-100 text-sun-700'
                      }`}>
                        {item.moderationStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-600 font-medium">{item.reportCount}</td>
                    <td className="px-4 py-3">
                      {state === 'loading' ? (
                        <span className="text-xs text-ink-400">Working…</span>
                      ) : state === 'error' ? (
                        <span className="text-xs text-red-500">Error — try again</span>
                      ) : (
                        <div className="flex gap-2">
                          {item.moderationStatus !== 'approved' && (
                            <button
                              type="button"
                              data-testid="admin-shared-republish"
                              onClick={() => handleSharedAction(item.id, 'republish')}
                              className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                              aria-label={`Republish lesson ${item.slug}`}
                            >
                              Republish
                            </button>
                          )}
                          {item.moderationStatus !== 'removed' && (
                            <button
                              type="button"
                              data-testid="admin-shared-take-down"
                              onClick={() => handleSharedAction(item.id, 'take_down')}
                              className="rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                              aria-label={`Take down lesson ${item.slug}`}
                            >
                              Take down
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
