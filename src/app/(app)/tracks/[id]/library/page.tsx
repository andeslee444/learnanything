import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { and, desc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';

export const dynamic = 'force-dynamic';

const RECORD_TYPE_LABELS: Record<string, string> = {
  demonstrated_understanding: 'Demonstrated',
  corrected_misconception: 'Corrected',
  prior_knowledge: 'Prior knowledge',
  mission_shift: 'Mission shift',
};

export default async function LibraryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: trackId } = await params;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) redirect('/signup');

  // Ownership ladder: track must belong to this learner
  const [track] = await db
    .select()
    .from(s.tracks)
    .where(and(eq(s.tracks.id, trackId), eq(s.tracks.learnerId, learner.id)));
  if (!track) notFound();

  // ── Three data queries ──────────────────────────────────────────────────────

  // 1. Glossary terms (all terms for this track)
  const glossaryTerms = await db
    .select({
      id: s.glossaryTerms.id,
      term: s.glossaryTerms.term,
      definition: s.glossaryTerms.definition,
      cluster: s.glossaryTerms.cluster,
    })
    .from(s.glossaryTerms)
    .where(eq(s.glossaryTerms.trackId, trackId))
    .orderBy(s.glossaryTerms.term);

  // 2. Reference docs (all docs for this track)
  const referenceDocs = await db
    .select({
      id: s.referenceDocs.id,
      title: s.referenceDocs.title,
      docType: s.referenceDocs.docType,
      updatedAt: s.referenceDocs.updatedAt,
    })
    .from(s.referenceDocs)
    .where(eq(s.referenceDocs.trackId, trackId))
    .orderBy(desc(s.referenceDocs.updatedAt));

  // 3. Learning records (newest-first), with superseded records available
  const learningRecords = await db
    .select({
      id: s.learningRecords.id,
      seq: s.learningRecords.seq,
      recordType: s.learningRecords.recordType,
      title: s.learningRecords.title,
      body: s.learningRecords.body,
      implications: s.learningRecords.implications,
      status: s.learningRecords.status,
      supersededById: s.learningRecords.supersededById,
      createdAt: s.learningRecords.createdAt,
    })
    .from(s.learningRecords)
    .where(eq(s.learningRecords.trackId, trackId))
    .orderBy(desc(s.learningRecords.createdAt));

  return (
    <main data-testid="library" className="mx-auto max-w-3xl px-6 py-8">
      {/* Page header */}
      <div className="mb-8">
        <nav className="mb-4">
          <Link
            href={`/tracks/${trackId}`}
            className="text-sm text-sky-600 hover:text-sky-700 underline underline-offset-2"
          >
            ← Back to learning map
          </Link>
        </nav>
        <h1 className="text-2xl font-bold text-ink-900">Library</h1>
        <p className="mt-1 text-sm text-ink-600">{track.topic}</p>
      </div>

      {/* ── Section 1: Glossary ──────────────────────────────────────────────── */}
      <section aria-label="Glossary" className="mb-10">
        <h2 className="text-lg font-semibold text-ink-900 mb-4">
          Terms you own
          {glossaryTerms.length > 0 && (
            <span className="ml-2 text-sm font-normal text-ink-600">
              ({glossaryTerms.length})
            </span>
          )}
        </h2>

        {glossaryTerms.length === 0 ? (
          <p className="text-sm text-ink-600 italic">
            No terms yet — complete a lesson to promote glossary terms.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {glossaryTerms.map((term) => (
              <div
                key={term.id}
                data-testid="glossary-term"
                className="rounded-lg border border-ink-400/20 bg-white px-4 py-3 shadow-sm"
              >
                <p className="font-medium text-ink-900">{term.term}</p>
                <p className="mt-1 text-sm text-ink-600 leading-snug">{term.definition}</p>
                {term.cluster && (
                  <span className="mt-2 inline-block rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700">
                    {term.cluster}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Section 2: Reference docs ────────────────────────────────────────── */}
      <section aria-label="Reference documents" className="mb-10">
        <h2 className="text-lg font-semibold text-ink-900 mb-4">
          Reference docs
          {referenceDocs.length > 0 && (
            <span className="ml-2 text-sm font-normal text-ink-600">
              ({referenceDocs.length})
            </span>
          )}
        </h2>

        {referenceDocs.length === 0 ? (
          <p className="text-sm text-ink-600 italic">
            No reference docs yet — they&apos;re generated automatically after you complete lessons.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {referenceDocs.map((doc) => (
              <Link
                key={doc.id}
                href={`/tracks/${trackId}/library/${doc.id}`}
                data-testid="reference-doc-card"
                className="group rounded-lg border border-ink-400/20 bg-white px-4 py-3 shadow-sm hover:border-sky-300 hover:shadow-md transition block"
              >
                <span className="inline-block mb-1.5 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 capitalize">
                  {doc.docType.replace(/_/g, ' ')}
                </span>
                <p className="font-medium text-ink-900 group-hover:text-sky-700 transition">
                  {doc.title}
                </p>
                <p className="mt-1 text-xs text-ink-600">
                  Updated {new Date(doc.updatedAt).toLocaleDateString()}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ── Section 3: Learning records timeline ─────────────────────────────── */}
      <section aria-label="What you've learned">
        <h2 className="text-lg font-semibold text-ink-900 mb-4">What you&apos;ve learned</h2>

        {learningRecords.length === 0 ? (
          <p className="text-sm text-ink-600 italic">
            No learning records yet — complete a lesson to build your record.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {learningRecords.map((record) => {
              const isSuperseded = record.status === 'superseded';

              return (
                <li
                  key={record.id}
                  data-testid="record-item"
                  className={`rounded-lg border px-4 py-3 ${
                    isSuperseded
                      ? 'border-ink-400/10 bg-ink-400/5'
                      : 'border-ink-400/20 bg-white shadow-sm'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {/* Type chip — sun-700 (#8c5e0a) on sun-100 (#fff3d6): 4.97:1 — passes WCAG AA. */}
                      <span
                        className={`inline-block mb-1.5 rounded-full px-2 py-0.5 text-sm font-semibold ${
                          record.recordType === 'demonstrated_understanding'
                            ? 'bg-sun-100 text-sun-700'
                            : record.recordType === 'corrected_misconception'
                            ? 'bg-sky-100 text-sky-700'
                            : 'bg-ink-400/10 text-ink-600'
                        }`}
                      >
                        {RECORD_TYPE_LABELS[record.recordType] ?? record.recordType}
                      </span>

                      {/* Title */}
                      <p
                        className={`font-medium text-sm ${
                          isSuperseded ? 'line-through text-ink-600' : 'text-ink-900'
                        }`}
                      >
                        {record.title}
                      </p>

                      {/* Body (collapsed/faded for superseded) */}
                      {!isSuperseded && (
                        <p className="mt-1 text-sm text-ink-600 leading-snug">{record.body}</p>
                      )}

                      {/* Superseded note */}
                      {isSuperseded && (
                        <p className="mt-1 text-xs text-ink-600 italic">
                          Understanding evolved
                        </p>
                      )}

                      {/* Implications */}
                      {!isSuperseded && record.implications && (
                        <p className="mt-2 text-xs text-ink-600 italic">
                          {record.implications}
                        </p>
                      )}
                    </div>

                    {/* Timestamp */}
                    <time
                      dateTime={record.createdAt.toISOString()}
                      className="shrink-0 text-xs text-ink-600 mt-0.5"
                    >
                      {new Date(record.createdAt).toLocaleDateString()}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </main>
  );
}
