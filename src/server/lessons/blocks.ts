import { z } from 'zod';

export const quizItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(8).max(400),
  options: z.array(z.string().min(1).max(200)).length(4),
  correctIndex: z.number().int().min(0).max(3),
  explanation: z.string().min(8).max(500), // shown AFTER answering (retrieval before explanation — spec §3)
});
export type QuizItem = z.infer<typeof quizItemSchema>;

export const articleBlockSchema = z.object({
  type: z.literal('article'),
  heading: z.string().min(3).max(120),
  markdown: z.string().min(50).max(7000),
  citationUrls: z.array(z.string()).min(1).max(10), // validator resolves against dossier sources
});
export const glossaryCalloutSchema = z.object({
  type: z.literal('glossary_callout'),
  term: z.string().min(1).max(80),
  definition: z.string().min(8).max(300),
});
export const quizBlockSchema = z.object({
  type: z.literal('quiz'),
  items: z.array(quizItemSchema).min(1).max(4),
});
export const flashcardDeckSchema = z.object({
  type: z.literal('flashcard_deck'),
  cards: z.array(z.object({ front: z.string().min(1).max(300), back: z.string().min(1).max(500) })).min(2).max(12),
});
export const workedExampleSchema = z.object({
  type: z.literal('worked_example'),
  problem: z.string().min(8).max(600),
  steps: z.array(z.object({ text: z.string().min(8).max(500) })).min(2).max(8),
  completionItem: quizItemSchema, // graded finish — keeps "≥1 graded interactive" semantics per block
});

// ── AnimatedDiagram — LLM emits ONLY parameterized primitives (spec §3: never markup) ──
export const diagramShapeSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(['box', 'circle', 'arrow', 'label']),
  // x/y: boxes/labels = top-left; circles = center (SVG semantics); arrows = start point with toX/toY end.
  x: z.number().min(0).max(100), y: z.number().min(0).max(100),   // percentage coords
  w: z.number().min(1).max(100).optional(), h: z.number().min(1).max(100).optional(),
  toX: z.number().min(0).max(100).optional(), toY: z.number().min(0).max(100).optional(), // arrows
  text: z.string().max(60).optional(),
});
export const animatedDiagramSchema = z.object({
  type: z.literal('animated_diagram'),
  title: z.string().min(3).max(120),
  shapes: z.array(diagramShapeSchema).min(2).max(20),
  steps: z.array(z.object({
    highlightIds: z.array(z.string()).min(1).max(10),
    caption: z.string().min(8).max(300),
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
  objective: z.string().min(8).max(200), // exactly ONE teachable thing
  format: z.literal('article'), // 4a ships one format
  estimatedMinutes: z.number().int().min(5).max(15),
  blockOutline: z
    .array(
      z.object({
        type: z.enum(['article', 'glossary_callout', 'quiz', 'flashcard_deck', 'worked_example', 'animated_diagram']),
        focus: z.string().min(3).max(200),
      }),
    )
    .min(2)
    .max(10),
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
