'use client';

import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';
import type { articleBlockSchema } from '@/server/lessons/blocks';
import type { z } from 'zod';

type ArticleBlock = z.infer<typeof articleBlockSchema>;

/**
 * Per-block verification status passed down from LessonView.
 * Matches the block_verification_status enum in the DB schema.
 */
export type BlockVerifyStatus = 'checking' | 'verified' | 'unverified' | 'regenerated';

type Props = {
  block: ArticleBlock;
  /** Optional verification status for this block. If absent, no badge is rendered. */
  verifyStatus?: BlockVerifyStatus;
};

// ── VerifyBadge — inline verification badge ──────────────────────────────────

/**
 * Per-block verification badge.
 *
 * States:
 *   checking    — subtle pulse dot + "checking sources"
 *   verified    — sky checkmark + "verified against sources"
 *   regenerated — same as verified + "updated" note (same visual treatment)
 *   unverified  — amber warning + "couldn't verify — review the sources"
 *
 * testid: verify-badge (consumed by e2e + acceptance tests)
 * aria-label: derived from state for screen reader clarity
 */
function VerifyBadge({ status }: { status: BlockVerifyStatus }) {
  if (status === 'checking') {
    return (
      <span
        data-testid="verify-badge"
        data-verify-status="checking"
        aria-label="Verifying sources — checking"
        className="inline-flex items-center gap-1.5 text-xs text-ink-400"
      >
        {/* Pulse dot */}
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-full bg-sky-400 animate-pulse"
        />
        checking sources
      </span>
    );
  }

  if (status === 'verified') {
    return (
      <span
        data-testid="verify-badge"
        data-verify-status="verified"
        aria-label="Verified against sources"
        className="inline-flex items-center gap-1.5 text-xs text-sky-600"
      >
        {/* Checkmark */}
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5 text-sky-500"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 8l4 4 6-6" />
        </svg>
        verified against sources
      </span>
    );
  }

  if (status === 'regenerated') {
    return (
      <span
        data-testid="verify-badge"
        data-verify-status="regenerated"
        aria-label="Verified against sources (content updated)"
        className="inline-flex items-center gap-1.5 text-xs text-sky-600"
      >
        {/* Same checkmark as verified */}
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5 text-sky-500"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 8l4 4 6-6" />
        </svg>
        verified against sources
        <span className="text-sky-400 font-medium">(updated)</span>
      </span>
    );
  }

  // unverified
  return (
    <span
      data-testid="verify-badge"
      data-verify-status="unverified"
      aria-label="Could not verify against sources — review sources manually"
      className="inline-flex items-center gap-1.5 text-xs text-amber-600"
    >
      {/* Warning triangle */}
      <svg
        aria-hidden="true"
        className="h-3.5 w-3.5 text-amber-500"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 2L1 14h14L8 2z" />
        <path d="M8 7v3" />
        <circle cx="8" cy="12" r="0.5" fill="currentColor" />
      </svg>
      {"couldn't verify — review the sources"}
    </span>
  );
}

export function ArticleSection({ block, verifyStatus }: Props) {
  return (
    <section data-testid="article-block" className="mt-6">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold text-ink-900">{block.heading}</h3>
        {/* Render badge only when a status is provided (backward-compatible: pre-Phase-6 = no badge) */}
        {verifyStatus !== undefined && (
          <div className="mt-0.5 shrink-0">
            <VerifyBadge status={verifyStatus} />
          </div>
        )}
      </div>
      <div className="mt-3 prose prose-ink max-w-none text-ink-900 text-base leading-relaxed">
        <Streamdown mode="static">{block.markdown}</Streamdown>
      </div>
      {block.citationUrls.length > 0 && (
        <footer className="mt-4 pt-3 border-t border-ink-400/20">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-400">Sources</p>
          <ul className="mt-1 flex flex-col gap-1">
            {block.citationUrls.map((url) => (
              <li key={url}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-sky-600 hover:text-sky-700 underline underline-offset-2 break-all"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </section>
  );
}
