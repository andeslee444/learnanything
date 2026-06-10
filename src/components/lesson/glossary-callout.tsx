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
      <p className="text-xs font-medium uppercase tracking-wide text-sun-700">Definition</p>
      <p className="mt-1 font-semibold text-ink-900">{block.term}</p>
      <p className="mt-1 text-sm text-ink-600">{block.definition}</p>
    </aside>
  );
}
