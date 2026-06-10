import { embed } from 'ai';
import { gateway } from 'ai';

export const EMBEDDING_DIMENSIONS = 1536; // matches topic_dossiers.embedding vector(1536)
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'; // via AI Gateway (verified available 2026-06-10)

/**
 * Deterministic fake: same text → same unit vector; different text → (near-)orthogonal.
 * Cosine-similar paraphrase behavior is NOT simulated — fake-mode cache tests use exact strings.
 */
function fakeEmbedding(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  const out = new Array<number>(EMBEDDING_DIMENSIONS);
  let state = h >>> 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0; // LCG — deterministic, no Math.random
    out[i] = (state / 0xffffffff) * 2 - 1;
  }
  const norm = Math.hypot(...out);
  return out.map((v) => v / norm);
}

export async function embedText(text: string): Promise<number[]> {
  if (process.env.AI_FAKE_LLM === '1') return fakeEmbedding(text);
  const { embedding } = await embed({
    model: gateway.textEmbeddingModel(EMBEDDING_MODEL),
    value: text,
  });
  return embedding;
}
