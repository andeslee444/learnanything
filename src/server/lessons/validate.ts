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
  if (!blocks.some((b) => b.type === 'quiz')) errors.push('no graded interactive block in body'); // spec §2 step 4
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

  return { ok: errors.length === 0, errors };
}

function allItemIds(blocks: LessonBlock[], winItems: { id: string }[]): string[] {
  return [
    ...blocks.flatMap((b) => (b.type === 'quiz' ? b.items.map((i) => i.id) : [])),
    ...winItems.map((i) => i.id),
  ];
}
