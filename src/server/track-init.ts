import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import * as s from '@/db/schema';
import { llmObject } from '@/lib/ai';
import { validateSkillGraph, type GraphInput } from '@/lib/skill-graph';

type Db = NodePgDatabase<typeof s>;

export const skillGraphSchema = z.object({
  nodes: z
    .array(
      z.object({
        name: z.string().min(2).max(120),
        summary: z.string().max(300),
        missionRelevance: z.number().min(0).max(1),
      })
    )
    .min(10)
    .max(40),
  edges: z.array(z.object({ node: z.string(), prereq: z.string() })).max(120),
});

export const calibrationQuizSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        question: z.string().min(8).max(400),
        options: z.array(z.string().min(1).max(200)).length(4),
        correctIndex: z.number().int().min(0).max(3),
        conceptName: z.string().max(120),
      })
    )
    .min(2)
    .max(4),
});
export type CalibrationQuiz = z.infer<typeof calibrationQuizSchema>;

const GRAPH_SYSTEM = `You decompose a learning mission into a skill graph for one learner.
Rules: 10-40 nodes; each node is ONE teachable skill ("can do X"), named in plain language;
edges are prerequisites only (prereq must be learned before node); keep prerequisite chains
short (max depth 5); missionRelevance in [0,1] ranks how directly a node serves the mission;
NEVER include topics the learner marked out of scope. The graph is a map, not a syllabus —
bias toward the shortest path to the mission's success criteria.`;

function graphPrompt(track: { topic: string; vertical: string }, mission: {
  whyText: string; successCriteria: unknown; constraints: unknown; outOfScope: string[];
}) {
  return [
    `Topic: ${track.topic} (vertical: ${track.vertical})`,
    `Why: ${mission.whyText}`,
    `Success criteria: ${JSON.stringify(mission.successCriteria)}`,
    `Constraints: ${JSON.stringify(mission.constraints)}`,
    `Out of scope (NEVER include): ${mission.outOfScope.join(', ') || 'none'}`,
  ].join('\n');
}

export type InitResult =
  | { status: 'initialized'; nodeCount: number; quiz: CalibrationQuiz }
  | { status: 'already_initialized' }
  | { status: 'failed'; errors: string[] };

/** Idempotent. Generates + validates the skill graph (one retry with validator errors), persists, then generates the calibration quiz. */
export async function initializeTrack(db: Db, trackId: string): Promise<InitResult> {
  const existing = await db.select({ id: s.skillNodes.id }).from(s.skillNodes).where(eq(s.skillNodes.trackId, trackId)).limit(1);
  if (existing.length > 0) return { status: 'already_initialized' };

  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, trackId));
  const [mission] = await db.select().from(s.missions).where(eq(s.missions.trackId, trackId));
  if (!track || !mission) return { status: 'failed', errors: ['track or mission missing'] };

  const prompt = graphPrompt(track, mission);
  let graph: GraphInput = await llmObject({
    purpose: 'skill-graph', tier: 'planner', schema: skillGraphSchema, system: GRAPH_SYSTEM, prompt,
  });
  let check = validateSkillGraph(graph, mission.outOfScope);
  if (!check.ok) {
    // ONE retry, feeding the validator errors back (spec §2; do not loop further).
    graph = await llmObject({
      purpose: 'skill-graph', tier: 'planner', schema: skillGraphSchema, system: GRAPH_SYSTEM,
      prompt: `${prompt}\n\nYour previous attempt failed validation:\n- ${check.errors.join('\n- ')}\nFix every issue.`,
    });
    check = validateSkillGraph(graph, mission.outOfScope);
    if (!check.ok) return { status: 'failed', errors: check.errors };
  }

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(s.skillNodes)
      .values(graph.nodes.map((n) => ({ trackId, name: n.name, summary: n.summary, missionRelevance: n.missionRelevance })))
      .returning({ id: s.skillNodes.id, name: s.skillNodes.name });
    const idByName = new Map(inserted.map((n) => [n.name, n.id]));
    if (graph.edges.length > 0) {
      await tx.insert(s.skillNodeEdges).values(
        graph.edges.map((e) => ({ nodeId: idByName.get(e.node)!, prereqId: idByName.get(e.prereq)! }))
      );
    }
  });

  const quiz = await llmObject({
    purpose: 'calibration-quiz', tier: 'generator', schema: calibrationQuizSchema,
    system:
      'Write a 2-4 item multiple-choice micro-quiz to calibrate a learner\'s starting level for the given skill graph. Each item probes ONE foundational node (use its exact name as conceptName). Plain language, one clearly-correct option, three plausible distractors. This is a friendly placement check, not a test.',
    prompt: `${prompt}\n\nFoundational nodes: ${graph.nodes.slice(0, 6).map((n) => n.name).join(', ')}`,
  });

  return { status: 'initialized', nodeCount: graph.nodes.length, quiz };
}

/**
 * Returns true if any calibration answer exists for this track.
 * Used by the track detail page (Task 7) to skip re-showing the quiz.
 */
export async function hasCalibration(db: Db, trackId: string): Promise<boolean> {
  const rows = await db
    .select({ id: s.attemptEvents.id })
    .from(s.attemptEvents)
    .where(
      sql`${s.attemptEvents.eventType} = 'calibration' AND ${s.attemptEvents.payload}->>'trackId' = ${trackId}`
    )
    .limit(1);
  return rows.length > 0;
}
