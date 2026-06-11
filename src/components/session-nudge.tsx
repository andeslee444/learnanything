'use client';

import { useEffect, useState } from 'react';

const NUDGE_DELAY_MS = 45 * 60 * 1000; // 45 minutes

/**
 * SessionNudge — dismissible banner shown after 45 minutes of continuous session.
 * Uses reduced-motion-safe CSS (no transform animation, no modal).
 * Testid: session-nudge.
 */
export function SessionNudge() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(true);
    }, NUDGE_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div
      data-testid="session-nudge"
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-xl border border-sky-200 bg-white px-4 py-3 shadow-md text-sm text-ink-800"
    >
      <span>{"You've been at it a while — a break helps it stick."}</span>
      <button
        onClick={() => setVisible(false)}
        aria-label="Dismiss session nudge"
        className="ml-2 text-ink-400 hover:text-ink-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        ✕
      </button>
    </div>
  );
}
