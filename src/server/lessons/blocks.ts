import { z } from 'zod';
import { llmText, llmTextRequired, llmArrayMax } from '@/lib/llm-schema';

export const quizItemSchema = z.object({
  id: z.string().min(1),
  question: llmTextRequired(8, 400),
  options: z.array(llmTextRequired(1, 200)).length(4),
  correctIndex: z.number().int().min(0).max(3), // STRICT: structural index into options array
  explanation: llmTextRequired(8, 500), // shown AFTER answering (retrieval before explanation — spec §3)
});
export type QuizItem = z.infer<typeof quizItemSchema>;

export const articleBlockSchema = z.object({
  type: z.literal('article'),
  heading: llmTextRequired(3, 120),
  markdown: llmTextRequired(50, 7000),
  citationUrls: z.array(z.string()).min(1).max(10), // validator resolves against dossier sources
});
export const glossaryCalloutSchema = z.object({
  type: z.literal('glossary_callout'),
  term: llmTextRequired(1, 80),
  definition: llmTextRequired(8, 300),
});
export const quizBlockSchema = z.object({
  type: z.literal('quiz'),
  items: z.array(quizItemSchema).min(1).max(4),
});
export const flashcardDeckSchema = z.object({
  type: z.literal('flashcard_deck'),
  cards: z
    .array(z.object({ front: llmTextRequired(1, 300), back: llmTextRequired(1, 500) }))
    .min(2) // STRICT: structural min — deck with <2 cards is malformed
    .transform((a) => (a.length > 12 ? a.slice(0, 12) : a)),
});
export const workedExampleSchema = z.object({
  type: z.literal('worked_example'),
  problem: llmTextRequired(8, 600),
  steps: z
    .array(z.object({ text: llmTextRequired(8, 500) }))
    .min(2) // STRICT: structural min — example with <2 steps is malformed
    .transform((a) => (a.length > 8 ? a.slice(0, 8) : a)),
  completionItem: quizItemSchema, // graded finish — keeps "≥1 graded interactive" semantics per block
});

// ── AnimatedDiagram — LLM emits ONLY parameterized primitives (spec §3: never markup) ──
export const diagramShapeSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(['box', 'circle', 'arrow', 'label']), // STRICT: enum
  // x/y: boxes/labels = top-left; circles = center (SVG semantics); arrows = start point with toX/toY end.
  x: z.number().min(0).max(100), y: z.number().min(0).max(100),   // percentage coords — STRICT: rendering math
  w: z.number().min(1).max(100).optional(), h: z.number().min(1).max(100).optional(),
  toX: z.number().min(0).max(100).optional(), toY: z.number().min(0).max(100).optional(), // arrows
  text: llmText(60).optional(),
});
export const animatedDiagramSchema = z.object({
  type: z.literal('animated_diagram'),
  title: llmTextRequired(3, 120),
  shapes: z.array(diagramShapeSchema).min(2).max(20),
  steps: z.array(z.object({
    highlightIds: z.array(z.string()).min(1).max(10),
    caption: llmTextRequired(8, 300),
  })).min(2).max(8),
});

export const lessonBlockSchema = z.discriminatedUnion('type', [
  articleBlockSchema,
  glossaryCalloutSchema,
  quizBlockSchema,
  flashcardDeckSchema,
  workedExampleSchema,
  animatedDiagramSchema,
]);
export type LessonBlock = z.infer<typeof lessonBlockSchema>;

export const winCheckSchema = z.object({
  items: z.array(quizItemSchema).min(2).max(4),
});

/** Generator output = body blocks + the win-check. Opener items are code-built, not LLM. */
export const lessonContentSchema = z.object({
  blocks: z.array(lessonBlockSchema).min(2).max(12),
  winCheck: winCheckSchema,
});
export type LessonContent = z.infer<typeof lessonContentSchema> & { openerItems: QuizItem[] };

/** Planner output (persisted to lessons.spec along with zpd snapshot). */
export const lessonPlanSchema = z.object({
  objective: llmTextRequired(8, 200), // exactly ONE teachable thing
  format: z.literal('article'), // 4a ships one format — STRICT: discriminator
  estimatedMinutes: z.number().int().min(5).max(15), // STRICT: numeric range validated downstream
  blockOutline: llmArrayMax(
    z.object({
      type: z.enum(['article', 'glossary_callout', 'quiz', 'flashcard_deck', 'worked_example', 'animated_diagram']), // STRICT: enum
      focus: llmTextRequired(3, 200),
    }),
    10,
  ),
});
export type LessonPlan = z.infer<typeof lessonPlanSchema>;

/** Win-check pass rule (spec §3: ≥85%): correct >= ceil(0.85 * n). With 2-4 MC items this means all-correct. */
export function winCheckPassed(correct: number, total: number): boolean {
  return correct >= Math.ceil(0.85 * total);
}

/**
 * Find an attempt item in lesson content by kind and itemId.
 * Scans openerItems, quiz blocks, worked_example completionItems, and winCheck items.
 * Returns the QuizItem or null if not found.
 */
export function findAttemptItem(
  content: LessonContent,
  kind: 'opener' | 'quiz' | 'win_check',
  itemId: string,
): QuizItem | null {
  if (kind === 'opener') {
    return content.openerItems.find((qi) => qi.id === itemId) || null;
  } else if (kind === 'quiz') {
    for (const block of content.blocks) {
      if (block.type === 'quiz') {
        const found = block.items.find((qi) => qi.id === itemId);
        if (found) return found;
      } else if (block.type === 'worked_example') {
        if (block.completionItem.id === itemId) {
          return block.completionItem;
        }
      }
    }
    return null;
  } else {
    // win_check
    return content.winCheck.items.find((qi) => qi.id === itemId) || null;
  }
}
