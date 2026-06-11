/**
 * /learn/[vertical]/[slug] — Public shared lesson page.
 *
 * NO auth required. Lives in the (learn) route group whose layout has no auth gate.
 *
 * Look up logic:
 *  - 404 when slug absent from shared_lessons
 *  - 404 when moderationStatus !== 'approved'
 *  - 404 when URL vertical != row's stored vertical (prevents taxonomy spoofing)
 *
 * Answer-key strip: sanitized content still carries correctIndex/explanation by spec.
 * getPublicLesson applies the P4b stripContentAnswerKey before returning.
 *
 * Renders:
 *  - Article, glossary-callout, flashcard, worked-example, animated-diagram blocks
 *    using existing read-only components (no auth wiring).
 *  - Quiz + win-check blocks: static question list with options (no submission),
 *    with a "Sign up to practice" note.
 *  - Badge display from badgeSnapshot (testid `public-badges`).
 *  - "Make this lesson yours" CTA → /signup (testid `make-it-yours`).
 *  - Footer: report button (testid `report-lesson`).
 *
 * OG/SEO: title = objective, description = first article first sentence.
 *
 * Page is dynamic (DB read per request).
 */

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getPublicLesson } from '@/server/lessons/public-lesson';
import { ArticleSection } from '@/components/lesson/article-section';
import { GlossaryCallout } from '@/components/lesson/glossary-callout';
import { FlashcardDeck } from '@/components/lesson/flashcard-deck';
import { AnimatedDiagram } from '@/components/lesson/animated-diagram';
import { ReportButton } from '@/components/lesson/report-button';

export const dynamic = 'force-dynamic';

// ── OG / SEO metadata ─────────────────────────────────────────────────────────

export async function generateMetadata(
  props: { params: Promise<{ vertical: string; slug: string }> },
): Promise<Metadata> {
  const { vertical, slug } = await props.params;
  const lesson = await getPublicLesson(db, vertical, slug);
  if (!lesson) {
    return { title: 'Lesson not found — LearnAnything' };
  }
  return {
    title: `${lesson.objective} — LearnAnything`,
    description: lesson.ogDescription,
    openGraph: {
      title: `${lesson.objective} — LearnAnything`,
      description: lesson.ogDescription,
      url: `/learn/${lesson.vertical}/${lesson.slug}`,
    },
  };
}

// ── Static quiz/win-check block (public — read-only, no submission) ───────────

type QuizItemPublic = {
  id: string;
  question: string;
  options: string[];
};

function StaticQuizBlock({ items, label }: { items: QuizItemPublic[]; label?: string }) {
  return (
    <div className="mt-6 rounded-xl border border-sky-200 bg-sky-50 px-6 py-5">
      {label && (
        <p className="text-xs font-medium uppercase tracking-wide text-sky-500 mb-3">{label}</p>
      )}
      {items.map((item) => (
        <div key={item.id} className="mb-5 last:mb-0">
          <p className="text-base font-medium text-ink-900">{item.question}</p>
          <div className="mt-3 flex flex-col gap-2">
            {item.options.map((option, i) => (
              <div
                key={i}
                className="rounded-lg border border-sky-200 bg-white px-4 py-3 text-sm text-ink-700"
              >
                {option}
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="mt-4 text-xs text-sky-500 italic">
        Sign up to practise and get instant feedback.
      </p>
    </div>
  );
}

// ── Badge display ─────────────────────────────────────────────────────────────

type BadgeBlock = { blockId: string; badge: 'verified' | 'unverified' };
type BadgeSnapshotShape = {
  overallStatus?: string;
  faithfulnessScore?: number | null;
  checkedAt?: string | null;
  blocks?: BadgeBlock[];
};

function PublicBadges({ badges }: { badges: BadgeSnapshotShape }) {
  const { overallStatus, checkedAt, blocks = [] } = badges;

  return (
    <div
      data-testid="public-badges"
      className="mt-6 rounded-xl border border-ink-400/20 bg-white px-5 py-4"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-400 mb-2">
        Source verification
      </p>

      {/* Overall status */}
      <div className="flex items-center gap-2 mb-2">
        {overallStatus === 'verified' ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-sky-700 font-medium">
            <svg aria-hidden="true" className="h-4 w-4 text-sky-500" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8l4 4 6-6" />
            </svg>
            Verified against sources
          </span>
        ) : overallStatus === 'issues' ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-amber-700 font-medium">
            <svg aria-hidden="true" className="h-4 w-4 text-amber-500" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2L1 14h14L8 2z" /><path d="M8 7v3" /><circle cx="8" cy="12" r="0.5" fill="currentColor" />
            </svg>
            Some sections could not be verified
          </span>
        ) : (
          <span className="text-sm text-ink-400">Verification in progress</span>
        )}
      </div>

      {/* Per-block badges */}
      {blocks.length > 0 && (
        <ul className="flex flex-wrap gap-2 mb-2">
          {blocks.map((b) => (
            <li key={b.blockId} className={`text-xs rounded-full px-2 py-0.5 font-medium ${
              b.badge === 'verified'
                ? 'bg-sky-100 text-sky-700'
                : 'bg-amber-100 text-amber-700'
            }`}>
              {b.blockId}: {b.badge}
            </li>
          ))}
        </ul>
      )}

      {/* Sources checked date */}
      <p className="text-xs text-ink-400">
        {checkedAt
          ? `Sources verified ${new Date(checkedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`
          : 'Verification in progress'}
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Block = {
  type: string;
  [key: string]: unknown;
};

type LessonContent = {
  blocks: Block[];
  winCheck: { items: QuizItemPublic[] };
};

export default async function PublicLessonPage(
  props: { params: Promise<{ vertical: string; slug: string }> },
) {
  const { vertical, slug } = await props.params;
  const lesson = await getPublicLesson(db, vertical, slug);

  if (!lesson) {
    notFound();
  }

  const contactEmail = process.env.CONTACT_EMAIL ?? 'support@learnanything.app';
  const content = lesson.content as LessonContent;
  const blocks = content?.blocks ?? [];
  const winCheckItems = content?.winCheck?.items ?? [];

  return (
    <article data-testid="public-lesson" className="mx-auto max-w-2xl px-6 py-10">
      {/* Objective / title */}
      <h1 className="text-2xl font-semibold text-ink-900">{lesson.objective}</h1>

      {/* Badge display */}
      <PublicBadges badges={lesson.badges} />

      {/* Main blocks */}
      <div className="mt-6 space-y-2">
        {blocks.map((block, idx) => {
          if (block.type === 'article') {
            return (
              <ArticleSection
                key={idx}
                block={block as Parameters<typeof ArticleSection>[0]['block']}
              />
            );
          }
          if (block.type === 'glossary_callout') {
            return (
              <GlossaryCallout
                key={idx}
                block={block as Parameters<typeof GlossaryCallout>[0]['block']}
              />
            );
          }
          if (block.type === 'quiz') {
            const items = (block.items ?? []) as QuizItemPublic[];
            return (
              <StaticQuizBlock key={idx} items={items} label="Practice questions" />
            );
          }
          if (block.type === 'flashcard_deck') {
            return (
              <FlashcardDeck
                key={idx}
                block={block as Parameters<typeof FlashcardDeck>[0]['block']}
              />
            );
          }
          if (block.type === 'worked_example') {
            // Static render: problem + steps are shown read-only.
            // The interactive WorkedExample component is NOT mounted here — it
            // POSTs to /api/lessons/:id/attempts which 401s for unauthenticated
            // visitors, producing silent failures. The completionItem is shown
            // via StaticQuizBlock with a "Sign up to practise" note, consistent
            // with the page's own static-rendering pattern for quiz/win-check blocks.
            const we = block as {
              type: 'worked_example';
              problem: string;
              steps: { text: string }[];
              completionItem: QuizItemPublic;
            };
            return (
              <div
                key={idx}
                data-testid="worked-example"
                className="mt-6 rounded-xl border border-sky-200 bg-sky-50 px-6 py-5"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-sky-500 mb-3">
                  Worked example
                </p>
                {/* Problem statement */}
                <p className="text-base font-medium text-ink-900 mb-4">{we.problem}</p>
                {/* Steps — all shown (no reveal progression on public page) */}
                <ol className="space-y-3 mb-4">
                  {we.steps.map((step, i) => (
                    <li
                      key={i}
                      data-testid={`we-step-${i}`}
                      className="flex gap-3 rounded-lg border border-sky-200 bg-white px-4 py-3"
                    >
                      <span className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-sky-100 text-xs font-semibold text-sky-600">
                        {i + 1}
                      </span>
                      <span className="text-sm text-ink-900">{step.text}</span>
                    </li>
                  ))}
                </ol>
                {/* Completion item — static, no submission */}
                {we.completionItem && (
                  <StaticQuizBlock
                    items={[we.completionItem]}
                    label="Check your understanding"
                  />
                )}
              </div>
            );
          }
          if (block.type === 'animated_diagram') {
            return (
              <AnimatedDiagram
                key={idx}
                block={block as Parameters<typeof AnimatedDiagram>[0]['block']}
              />
            );
          }
          return null;
        })}
      </div>

      {/* Win-check — static (no submission) */}
      {winCheckItems.length > 0 && (
        <StaticQuizBlock
          items={winCheckItems}
          label="Win check — can you answer these?"
        />
      )}

      {/* CTA */}
      <div className="mt-10 rounded-xl bg-sky-50 border border-sky-200 px-6 py-6 text-center">
        <p className="text-base font-semibold text-ink-900">Make this lesson yours</p>
        <p className="mt-1 text-sm text-ink-600">
          Sign up to practise interactively, track your progress, and build your own personalised curriculum.
        </p>
        <Link
          data-testid="make-it-yours"
          href="/signup"
          className="mt-4 inline-block rounded-lg bg-sky-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Get started free
        </Link>
      </div>

      {/* Footer: DMCA/report */}
      <div className="mt-8 border-t border-ink-400/20 pt-5 flex items-center justify-between gap-4 flex-wrap">
        <p className="text-xs text-ink-400">
          DMCA / copyright concerns:{' '}
          <a
            href={`mailto:${contactEmail}`}
            className="underline underline-offset-2 hover:text-sky-700"
          >
            {contactEmail}
          </a>
        </p>
        <ReportButton slug={slug} />
      </div>
    </article>
  );
}
