import { describe, it, expect } from 'vitest';
import { validateSkillGraph, type GraphInput } from './skill-graph';

function nodes(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `n${i}`, summary: '', missionRelevance: 0.5 }));
}
function chain(n: number) {
  return Array.from({ length: n - 1 }, (_, i) => ({ node: `n${i + 1}`, prereq: `n${i}` }));
}
const valid: GraphInput = { nodes: nodes(10), edges: chain(5) };

describe('validateSkillGraph', () => {
  it('accepts a valid graph', () => {
    expect(validateSkillGraph(valid, []).ok).toBe(true);
  });
  it('rejects too few or too many nodes', () => {
    expect(validateSkillGraph({ nodes: nodes(9), edges: [] }, []).ok).toBe(false);
    expect(validateSkillGraph({ nodes: nodes(41), edges: [] }, []).ok).toBe(false);
  });
  it('rejects duplicate node names', () => {
    const dup = { nodes: [...nodes(10), { name: 'n0', summary: '', missionRelevance: 0.5 }], edges: [] };
    expect(validateSkillGraph(dup, []).ok).toBe(false);
  });
  it('rejects edges to unknown nodes', () => {
    expect(validateSkillGraph({ nodes: nodes(10), edges: [{ node: 'n0', prereq: 'ghost' }] }, []).ok).toBe(false);
  });
  it('rejects self-loops and cycles', () => {
    expect(validateSkillGraph({ nodes: nodes(10), edges: [{ node: 'n0', prereq: 'n0' }] }, []).ok).toBe(false);
    const cyc = [{ node: 'n1', prereq: 'n0' }, { node: 'n2', prereq: 'n1' }, { node: 'n0', prereq: 'n2' }];
    expect(validateSkillGraph({ nodes: nodes(10), edges: cyc }, []).ok).toBe(false);
  });
  it('rejects prerequisite chains deeper than 5', () => {
    expect(validateSkillGraph({ nodes: nodes(10), edges: chain(7) }, []).ok).toBe(false); // depth 7
    expect(validateSkillGraph({ nodes: nodes(10), edges: chain(5) }, []).ok).toBe(true); // depth 5
  });
  it('rejects nodes matching out-of-scope topics (case-insensitive substring)', () => {
    const g = { nodes: [...nodes(9), { name: 'Advanced Macros', summary: '', missionRelevance: 0.5 }], edges: [] };
    const res = validateSkillGraph(g, ['macros']);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/out-of-scope/i);
  });
});
