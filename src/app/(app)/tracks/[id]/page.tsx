import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getLearnerByUserId } from '@/server/learners';
import { getTrackDetail } from '@/server/tracks';
import { hasCalibration } from '@/server/track-init';
import { TrackSetup } from './track-setup';

type NodeMastery = 'not_started' | 'in_progress' | 'demonstrated' | 'mastered';

const MASTERY_GROUP_LABELS: Record<string, string> = {
  not_started: 'Up next',
  in_progress: 'In progress',
  done: 'Done',
};

function masteryGroup(mastery: NodeMastery): 'not_started' | 'in_progress' | 'done' {
  if (mastery === 'demonstrated' || mastery === 'mastered') return 'done';
  return mastery;
}

export default async function TrackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) redirect('/signup');

  const detail = await getTrackDetail(db, id, learner.id);
  if (!detail) notFound();

  const { track, mission, nodes } = detail;

  const calibrated = nodes.length > 0 ? await hasCalibration(db, id) : false;

  // Group nodes by mastery
  const groups: Record<'not_started' | 'in_progress' | 'done', typeof nodes> = {
    not_started: [],
    in_progress: [],
    done: [],
  };
  for (const node of nodes) {
    groups[masteryGroup(node.mastery as NodeMastery)].push(node);
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      {/* Mission card (read-only) */}
      {mission && (
        <section className="rounded-xl border border-ink-400/20 bg-cloud p-6 shadow-sm" aria-label="Your mission">
          <h1 className="text-xl font-medium text-ink-900">{track.topic}</h1>
          <span className="mt-1 inline-block rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 capitalize">
            {track.vertical}
          </span>

          <div className="mt-5">
            <h2 className="text-sm font-medium uppercase tracking-wide text-ink-400">Why you&apos;re learning this</h2>
            <p className="mt-1 text-ink-900">{mission.whyText}</p>
          </div>

          {Array.isArray(mission.successCriteria) && (mission.successCriteria as Array<{ description: string }>).length > 0 && (
            <div className="mt-4">
              <h2 className="text-sm font-medium uppercase tracking-wide text-ink-400">Success criteria</h2>
              <ul className="mt-1 list-disc pl-5 text-ink-900">
                {(mission.successCriteria as Array<{ description: string }>).map((c, i) => (
                  <li key={i}>{c.description}</li>
                ))}
              </ul>
            </div>
          )}

          {mission.constraints != null && typeof mission.constraints === 'object' && Object.keys(mission.constraints as Record<string, unknown>).length > 0 && (
            <div className="mt-4">
              <h2 className="text-sm font-medium uppercase tracking-wide text-ink-400">Constraints</h2>
              <p className="mt-1 text-sm text-ink-600">
                {Object.entries(mission.constraints as Record<string, string>)
                  .filter(([, v]) => v)
                  .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${v}`)
                  .join(' · ')}
              </p>
            </div>
          )}

          {Array.isArray(mission.outOfScope) && (mission.outOfScope as string[]).length > 0 && (
            <div className="mt-4">
              <h2 className="text-sm font-medium uppercase tracking-wide text-ink-400">Out of scope</h2>
              <div className="mt-1 flex flex-wrap gap-2">
                {(mission.outOfScope as string[]).map((tag, i) => (
                  <span key={i} className="rounded-full bg-ink-400/10 px-3 py-0.5 text-xs text-ink-600">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Build flow (no nodes yet) */}
      {nodes.length === 0 && (
        <TrackSetup trackId={id} mode="build" />
      )}

      {/* Learning map (nodes exist) */}
      {nodes.length > 0 && (
        <section className="mt-8" aria-label="Learning map">
          <h2 className="text-lg font-medium text-ink-900">Learning map</h2>
          <p
            data-testid="map-summary"
            className="mt-1 text-sm text-ink-600"
          >
            {nodes.length} skill{nodes.length !== 1 ? 's' : ''} in your map
          </p>

          {(['not_started', 'in_progress', 'done'] as const).map((group) => {
            const groupNodes = groups[group];
            if (groupNodes.length === 0) return null;
            return (
              <div key={group} className="mt-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  {MASTERY_GROUP_LABELS[group]}
                </h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  {groupNodes.map((node) => (
                    <span
                      key={node.id}
                      data-testid="map-node"
                      className="rounded-full bg-sun-100 px-3 py-1 text-sm text-sun-700"
                      aria-label={`Skill: ${node.name}`}
                    >
                      {node.name}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Calibration (only if not yet calibrated) */}
          {!calibrated && (
            <TrackSetup trackId={id} mode="calibrate" />
          )}

          {/* Lesson stub */}
          <div
            className="mt-8 rounded-xl bg-sun-100 px-5 py-4 text-sun-700"
            data-testid="lesson-stub"
          >
            <p className="font-medium">Your first lesson is coming soon</p>
            <p className="mt-1 text-sm">Lesson generation arrives in the next phase — your learning map is ready for it.</p>
          </div>
        </section>
      )}
    </main>
  );
}
