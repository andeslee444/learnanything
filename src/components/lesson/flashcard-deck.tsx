'use client';

import { useState } from 'react';
import type { flashcardDeckSchema } from '@/server/lessons/blocks';
import type { z } from 'zod';

type FlashcardDeckBlock = z.infer<typeof flashcardDeckSchema>;

type Props = {
  block: FlashcardDeckBlock;
};

/**
 * FlashcardDeck — spaced-repetition preview for Phase 4b.
 *
 * Flips emit NO attempt events in Phase 4b.
 * FSRS-based scheduling and attempt tracking arrive in Phase 5.
 *
 * Reduced motion is handled by the global CSS rule in globals.css
 * (transition-duration: 0.01ms !important under prefers-reduced-motion: reduce)
 * so no per-component guard is needed.
 */
export function FlashcardDeck({ block }: Props) {
  const [cardIndex, setCardIndex] = useState(0);
  // false = showing front, true = showing back
  const [flipped, setFlipped] = useState(false);

  const card = block.cards[cardIndex];
  const total = block.cards.length;

  function handleFlip() {
    setFlipped((f) => !f);
  }

  function handlePrev() {
    setFlipped(false);
    setCardIndex((i) => Math.max(0, i - 1));
  }

  function handleNext() {
    setFlipped(false);
    setCardIndex((i) => Math.min(total - 1, i + 1));
  }

  if (!card) return null;

  return (
    <div
      data-testid="flashcard-deck"
      className="mt-6 rounded-xl border border-sky-200 bg-sky-50 px-6 py-5"
    >
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium uppercase tracking-wide text-sky-500">Flashcards</p>
        <p className="text-xs text-sky-400" aria-label={`Card ${cardIndex + 1} of ${total}`}>
          card {cardIndex + 1} of {total}
        </p>
      </div>

      {/* Card flip container */}
      <button
        data-testid="flashcard-flip"
        onClick={handleFlip}
        aria-pressed={flipped}
        aria-label={flipped ? 'Showing back — click to flip to front' : 'Showing front — click to flip to back'}
        className="w-full rounded-lg border border-sky-200 bg-white px-5 py-6 text-left min-h-[100px] flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        style={{
          /* CSS 3D flip — transition honours reduced-motion via the global rule */
          transition: 'transform 0.35s',
        }}
      >
        <span className="text-base text-ink-900 text-center">
          {flipped ? card.back : card.front}
        </span>
      </button>

      <p className="mt-2 text-xs text-sky-400 text-center">
        {flipped ? 'Back' : 'Front'} — click the card to flip
      </p>

      {/* Navigation */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <button
          data-testid="flashcard-prev"
          onClick={handlePrev}
          disabled={cardIndex === 0}
          aria-label="Previous card"
          className="rounded-lg border border-sky-200 bg-white px-4 py-2 text-sm text-sky-600 hover:border-sky-400 hover:bg-sky-50 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          ← Prev
        </button>
        <button
          data-testid="flashcard-next"
          onClick={handleNext}
          disabled={cardIndex === total - 1}
          aria-label="Next card"
          className="rounded-lg border border-sky-200 bg-white px-4 py-2 text-sm text-sky-600 hover:border-sky-400 hover:bg-sky-50 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
