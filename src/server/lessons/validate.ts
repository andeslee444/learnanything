import type { LessonBlock, LessonContent } from './blocks';

export type LessonValidationInput = {
  content: Omit<LessonContent, 'openerItems'>;
  dossierSourceUrls: string[];
};

/** 4a validator subset (spec §2 step 4). Readability + glossary-alias scans land in 4b. */
export function validateLessonContent(input: LessonValidationInput): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const { blocks, winCheck } = input.content;
  const known = new Set(input.dossierSourceUrls);

  if (!blocks.some((b) => b.type === 'article')) errors.push('no article block');
  // A "graded interactive" block is a quiz block OR a worked_example (which contains a completionItem).
  if (!blocks.some((b) => b.type === 'quiz' || b.type === 'worked_example'))
    errors.push('no graded interactive block in body'); // spec §2 step 4
  for (const block of blocks) {
    if (block.type === 'article') {
      const resolved = block.citationUrls.filter((u) => known.has(u));
      if (resolved.length === 0)
        errors.push(`article "${block.heading}" has no citation resolving to a dossier source`);
    }
  }
  const ids = allItemIds(blocks, winCheck.items);
  if (new Set(ids).size !== ids.length) errors.push('duplicate quiz item ids');
  const totalChars = blocks.reduce((n, b) => n + (b.type === 'article' ? b.markdown.length : 0), 0);
  if (totalChars > 9000)
    errors.push(`article text ${totalChars} chars exceeds the 5-15 minute budget proxy (9000)`);

  // ── AnimatedDiagram structural validators ────────────────────────────────────
  for (const block of blocks) {
    if (block.type === 'animated_diagram') {
      const shapeIds = new Set(block.shapes.map((s) => s.id));
      // All highlightIds must reference a known shape id
      for (let stepIdx = 0; stepIdx < block.steps.length; stepIdx++) {
        const step = block.steps[stepIdx];
        for (const hid of step.highlightIds) {
          if (!shapeIds.has(hid)) {
            errors.push(
              `animated_diagram "${block.title}" step ${stepIdx + 1} highlightId "${hid}" does not match any shape id`,
            );
          }
        }
      }
      // Arrows require toX and toY
      for (const shape of block.shapes) {
        if (shape.kind === 'arrow' && (shape.toX === undefined || shape.toY === undefined)) {
          errors.push(
            `animated_diagram "${block.title}" shape "${shape.id}" is an arrow but is missing toX or toY`,
          );
        }
        // Labels require text
        if (shape.kind === 'label' && !shape.text) {
          errors.push(
            `animated_diagram "${block.title}" shape "${shape.id}" is a label but is missing text`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function allItemIds(blocks: LessonBlock[], winItems: { id: string }[]): string[] {
  return [
    ...blocks.flatMap((b) => {
      if (b.type === 'quiz') return b.items.map((i) => i.id);
      if (b.type === 'worked_example') return [b.completionItem.id];
      return [];
    }),
    ...winItems.map((i) => i.id),
  ];
}
