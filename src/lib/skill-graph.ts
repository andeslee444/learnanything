export type GraphNode = { name: string; summary: string; missionRelevance: number };
export type GraphEdge = { node: string; prereq: string };
export type GraphInput = { nodes: GraphNode[]; edges: GraphEdge[] };

const MIN_NODES = 10;
const MAX_NODES = 40;
const MAX_DEPTH = 5; // longest prerequisite chain, counted in nodes

/** Spec §2 track initialization: acyclic, 10–40 nodes, depth ≤ 5, out_of_scope excluded. */
export function validateSkillGraph(
  graph: GraphInput,
  outOfScope: string[]
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const names = graph.nodes.map((n) => n.name);
  const nameSet = new Set(names);

  if (names.length < MIN_NODES || names.length > MAX_NODES) {
    errors.push(`node count ${names.length} outside ${MIN_NODES}-${MAX_NODES}`);
  }
  if (nameSet.size !== names.length) errors.push('duplicate node names');

  for (const scope of outOfScope) {
    const hit = names.find((n) => n.toLowerCase().includes(scope.toLowerCase()));
    if (hit) errors.push(`node "${hit}" matches out-of-scope topic "${scope}"`);
  }

  for (const e of graph.edges) {
    if (!nameSet.has(e.node) || !nameSet.has(e.prereq)) {
      errors.push(`edge references unknown node: ${e.prereq} -> ${e.node}`);
    }
    if (e.node === e.prereq) errors.push(`self-loop on "${e.node}"`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // Kahn's algorithm: detects cycles and computes longest chain in one pass.
  const indegree = new Map(names.map((n) => [n, 0]));
  const children = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of graph.edges) {
    indegree.set(e.node, (indegree.get(e.node) ?? 0) + 1);
    children.get(e.prereq)!.push(e.node);
  }
  const depth = new Map(names.map((n) => [n, 1]));
  const queue = names.filter((n) => indegree.get(n) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const n = queue.shift()!;
    visited++;
    for (const child of children.get(n)!) {
      depth.set(child, Math.max(depth.get(child)!, depth.get(n)! + 1));
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  if (visited !== names.length) errors.push('graph contains a cycle');
  const maxDepth = Math.max(...depth.values());
  if (maxDepth > MAX_DEPTH) errors.push(`prerequisite chain depth ${maxDepth} exceeds ${MAX_DEPTH}`);

  return { ok: errors.length === 0, errors };
}
