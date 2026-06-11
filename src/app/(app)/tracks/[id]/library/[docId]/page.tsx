import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { PrintButton } from './print-button';

export const dynamic = 'force-dynamic';

type DocSection = {
  heading: string;
  markdown: string;
};

export default async function ReferenceDocPage({
  params,
}: {
  params: Promise<{ id: string; docId: string }>;
}) {
  const { id: trackId, docId } = await params;

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

  // Fetch the reference doc (must belong to this track)
  const [doc] = await db
    .select()
    .from(s.referenceDocs)
    .where(and(eq(s.referenceDocs.id, docId), eq(s.referenceDocs.trackId, trackId)));
  if (!doc) notFound();

  const content = doc.content as { sections?: DocSection[] };
  const sections: DocSection[] = content.sections ?? [];

  return (
    <main className="mx-auto max-w-3xl px-6 py-8 print-serif">
      {/* Navigation (hidden in print) */}
      <nav className="no-print mb-6 flex items-center gap-3">
        <Link
          href={`/tracks/${trackId}/library`}
          className="text-sm text-sky-600 hover:text-sky-700 underline underline-offset-2"
        >
          ← Back to Library
        </Link>
        <span className="text-ink-400/60" aria-hidden="true">·</span>
        <Link
          href={`/tracks/${trackId}`}
          className="text-sm text-sky-600 hover:text-sky-700 underline underline-offset-2"
        >
          Learning map
        </Link>
      </nav>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <span className="no-print inline-block mb-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 capitalize">
            {doc.docType.replace(/_/g, ' ')}
          </span>
          <h1 className="text-2xl font-bold text-ink-900">{doc.title}</h1>
        </div>
        <PrintButton />
      </div>

      {/* Sections */}
      {sections.length === 0 ? (
        <p className="text-ink-600">This document has no content yet.</p>
      ) : (
        <div className="space-y-8">
          {sections.map((section, i) => (
            <section key={i} className="print-section">
              <h2 className="text-lg font-semibold text-ink-900 mb-3">{section.heading}</h2>
              <div className="prose prose-ink max-w-none text-ink-900 text-base leading-relaxed">
                <Streamdown mode="static">{section.markdown}</Streamdown>
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Footer (hidden in print) */}
      <footer className="no-print mt-12 pt-6 border-t border-ink-400/20">
        <p className="text-xs text-ink-400">
          {doc.linkedLessonIds.length} lesson{doc.linkedLessonIds.length === 1 ? '' : 's'} linked ·
          Last updated {new Date(doc.updatedAt).toLocaleDateString()}
        </p>
      </footer>
    </main>
  );
}
