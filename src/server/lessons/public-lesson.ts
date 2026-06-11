/**
 * public-lesson.ts — Server-side data layer for the public /learn route.
 *
 * getPublicLesson(db, vertical, slug):
 *   - Looks up shared_lessons by slug
 *   - Returns null when the row is absent, moderationStatus !== 'approved',
 *     or the URL vertical segment doesn't match the row's vertical (prevents
 *     vertical taxonomy spoofing).
 *   - Applies the P4b answer-key strip (stripContentAnswerKey) to sanitized content
 *     before returning — sanitized content still carries correctIndex/explanation by
 *     spec; the public read path must strip them.
 *
 * Exported separately so tests can exercise the data-prep path without
 * spinning up a full Next.js page.
 */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';
import { stripContentAnswerKey } from '@/app/api/lessons/[lessonId]/route';
import type { BadgeSnapshot } from './share';

type Db = NodePgDatabase<typeof s>;

export type PublicLessonData = {
  /** Slug (for the report endpoint and OG URL) */
  slug: string;
  /** Vertical (for OG / URL validation) */
  vertical: string;
  /**
   * Sanitized content with answer keys stripped.
   * Shape: { blocks: LessonBlock[], winCheck: { items: QuizItem[] } }
   * correctIndex + explanation are absent from all quiz-bearing structures.
   */
  content: unknown;
  /** Badge snapshot — may have empty blocks array if no verification was run. */
  badges: BadgeSnapshot;
  /**
   * Lesson objective — from the sanitized content's spec, or derived from the
   * first article block's heading if not available.
   * Used for OG title and the page heading.
   */
  objective: string;
  /** First sentence of the first article block's markdown — for OG description. */
  ogDescription: string;
};

/**
 * Look up and prepare a shared lesson for the public page.
 *
 * Returns null when:
 *  - No shared_lessons row found for the slug
 *  - moderationStatus !== 'approved'
 *  - The slug's vertical segment does not match the row's stored vertical
 *
 * Answer keys (correctIndex + explanation) are stripped from all quiz-bearing
 * structures before returning.
 */
export async function getPublicLesson(
  db: Db,
  vertical: string,
  slug: string,
): Promise<PublicLessonData | null> {
  const [row] = await db
    .select()
    .from(s.sharedLessons)
    .where(eq(s.sharedLessons.slug, slug));

  if (!row) return null;

  // Only 'approved' rows are visible on the public page.
  if (row.moderationStatus !== 'approved') return null;

  // Defense-in-depth: URL vertical must match the stored vertical.
  // Prevents spoofing the taxonomy via /learn/wrong-vertical/slug.
  if (row.vertical !== vertical) return null;

  // Apply the P4b answer-key strip to sanitized content.
  // sanitizeLessonContent leaves correctIndex/explanation intact by spec;
  // the public page must not expose them.
  const strippedContent = stripContentAnswerKey(row.sanitizedContent);

  const badges = (row.badgeSnapshot ?? {}) as BadgeSnapshot;

  // Derive objective from the spec embedded in the sanitized content if available,
  // otherwise fall back to the first article block heading.
  const rawContent = row.sanitizedContent as {
    blocks?: Array<{ type: string; heading?: string; markdown?: string }>;
  } | null;
  const blocks = rawContent?.blocks ?? [];

  const firstArticle = blocks.find((b) => b.type === 'article');
  const objective = firstArticle?.heading ?? 'Learn something new';

  // OG description: first sentence of the first article block's markdown.
  let ogDescription = 'AI-generated lesson, verified against sources.';
  if (firstArticle?.markdown) {
    const firstSentenceMatch = firstArticle.markdown.match(/^[^.!?\n]+[.!?]/);
    if (firstSentenceMatch) {
      // Strip markdown bold/italic asterisks for clean OG text
      ogDescription = firstSentenceMatch[0].replace(/\*+/g, '').trim();
    } else {
      // No terminal punctuation — take up to 160 chars
      ogDescription = firstArticle.markdown.slice(0, 160).replace(/\*+/g, '').trim();
    }
  }

  return {
    slug: row.slug,
    vertical: row.vertical,
    content: strippedContent,
    badges,
    objective,
    ogDescription,
  };
}
