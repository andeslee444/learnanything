import type { glossaryCalloutSchema } from '@/server/lessons/blocks';
import type { z } from 'zod';

type GlossaryBlock = z.infer<typeof glossaryCalloutSchema>;

type Props = {
  block: GlossaryBlock;
};

export function GlossaryCallout({ block }: Props) {
  return (
    <aside
      data-testid="glossary-block"
      className="mt-6 rounded-xl border border-sun-300 bg-sun-100 px-5 py-4"
      aria-label={`Definition: ${block.term}`}
    >
      {/* sun-700 (#8c5e0a) on sun-100 (#fff3d6): 4.97:1 — passes WCAG AA for all text sizes. */}
      <p className="text-sm font-semibold uppercase tracking-wide text-sun-700">Definition</p>
      <p className="mt-1 font-semibold text-ink-900">{block.term}</p>
      <p className="mt-1 text-sm text-ink-600">{block.definition}</p>
    </aside>
  );
}
