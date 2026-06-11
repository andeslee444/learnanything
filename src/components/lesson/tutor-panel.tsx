'use client';

import { useState, useRef } from 'react';

type TutorMessage = {
  role: 'learner' | 'tutor';
  text: string;
};

type TutorPanelProps = {
  lessonId: string;
};

// Crisis resources panel — rendered instead of a normal reply when crisis=true.
function CrisisResources() {
  return (
    <div
      data-testid="crisis-resources"
      className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
      role="alert"
    >
      <p className="font-semibold mb-2">It sounds like you may be going through something difficult. You are not alone.</p>
      <ul className="space-y-1">
        <li>
          <strong>988 Suicide &amp; Crisis Lifeline:</strong> Call or text <strong>988</strong> (US)
        </li>
        <li>
          <strong>Crisis Text Line:</strong> Text <strong>HOME</strong> to <strong>741741</strong>
        </li>
        <li>
          <strong>International resources:</strong>{' '}
          <a
            href="https://www.befrienders.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            befrienders.org
          </a>
        </li>
      </ul>
    </div>
  );
}

/**
 * TutorPanel — collapsible AI tutor below the lesson blocks.
 *
 * Conversation is session-local React state only — NOT persisted to the database.
 * Rationale: transcripts are deliberately not stored in v1 per spec §6 retention;
 * the tutor is a low-friction hint layer, not a logged interaction record.
 */
export function TutorPanel({ lessonId }: TutorPanelProps) {
  const [open, setOpen] = useState(false);
  // Session-local state — NOT persisted; see comment above.
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // crisisActive intentionally persists for the session once triggered (no dismiss) —
  // the resources panel stays visible until the learner navigates away. Spec §6 intent.
  const [crisisActive, setCrisisActive] = useState(false);
  const liveRef = useRef<HTMLParagraphElement | null>(null);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);

    const userMsg: TutorMessage = { role: 'learner', text };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    try {
      const res = await fetch(`/api/lessons/${lessonId}/tutor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });

      if (res.status === 429) {
        setError('Slow down a moment before sending another question.');
        setSending(false);
        return;
      }
      if (res.status === 422) {
        setError('That message could not be processed.');
        setSending(false);
        return;
      }
      if (!res.ok) {
        setError('Tutor unavailable — please try again shortly.');
        setSending(false);
        return;
      }

      const data = (await res.json()) as { crisis: boolean; reply: string };

      if (data.crisis) {
        setCrisisActive(true);
        // Still add the tutor's compassionate reply to the conversation.
        setMessages((prev) => [...prev, { role: 'tutor', text: data.reply }]);
        if (liveRef.current) {
          liveRef.current.textContent = 'Crisis resources shown below.';
        }
      } else {
        setMessages((prev) => [...prev, { role: 'tutor', text: data.reply }]);
        if (liveRef.current) {
          liveRef.current.textContent = 'Tutor replied.';
        }
      }
    } catch {
      setError('Network error — please check your connection.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div data-testid="tutor-panel" className="mt-8 rounded-xl border border-sky-200 bg-sky-50/30">
      {/* Collapsed header */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-5 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <span className="text-sm font-medium text-sky-800">
          Ask the AI tutor
          {/* SB-243 disclosure — always visible */}
          <span className="ml-2 text-xs font-normal text-ink-500">AI tutor — answers can be imperfect</span>
        </span>
        <span aria-hidden="true" className="text-sky-600 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-5 pb-4">
          {/* Persistent AI disclosure label */}
          <p className="mb-3 text-xs text-ink-500">AI tutor — answers can be imperfect</p>

          {/* Aria-live region for screen readers */}
          <p ref={liveRef} aria-live="polite" aria-atomic="true" className="sr-only" />

          {/* Conversation — plain text only (not markdown) */}
          {messages.length > 0 && (
            <div className="mb-3 space-y-2 max-h-64 overflow-y-auto">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'learner'
                      ? 'bg-sky-100 text-ink-800 ml-8'
                      : 'bg-white border border-sky-100 text-ink-800 mr-8'
                  }`}
                >
                  {/* Plain text — not markdown rendered. Replies are plain text per spec. */}
                  <span className="font-medium text-xs text-ink-500 mr-1">
                    {msg.role === 'learner' ? 'You:' : 'Tutor:'}
                  </span>
                  {msg.text}
                </div>
              ))}
            </div>
          )}

          {/* Crisis resources — shown when crisis detected */}
          {crisisActive && <CrisisResources />}

          {/* Error */}
          {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

          {/* Input row */}
          <div className="flex gap-2">
            <input
              data-testid="tutor-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Ask a question about the lesson…"
              maxLength={1000}
              disabled={sending}
              className="flex-1 rounded-lg border border-sky-200 bg-white px-3 py-2 text-sm text-ink-800 placeholder:text-ink-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60"
            />
            <button
              data-testid="tutor-send"
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              aria-label="Send question to tutor"
            >
              {sending ? 'Sending…' : 'Ask'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
