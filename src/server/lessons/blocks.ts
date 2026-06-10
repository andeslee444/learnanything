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
export const lessonBlockSchema = z.discriminatedUnion('type', [
  articleBlockSchema,
  glossaryCalloutSchema,
  quizBlockSchema,
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
        type: z.enum(['article', 'glossary_callout', 'quiz']),
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
