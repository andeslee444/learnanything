/**
 * TTS narration helpers — Phase 8.
 *
 * buildNarrationScript:
 *   Deterministic plain-text script from lesson content. Objective sentence +
 *   article blocks (headings + stripped markdown) + glossary callouts
 *   ("Term: definition"). Quizzes, worked examples, flashcard decks,
 *   animated diagrams, and win-check items are intentionally skipped — the
 *   closer "Now try the practice questions on screen." is appended instead.
 *   Truncated to ≤ ~4500 chars at a sentence boundary (TTS API input limit guard).
 *
 * synthesizeNarration:
 *   Fake mode (AI_FAKE_LLM=1 or OPENAI_API_KEY absent): returns a valid 1-second
 *   silent WAV Buffer (44-byte header + 44100 silent int16 samples).
 *   Real mode: POST https://api.openai.com/v1/audio/speech → mp3 Buffer (60s timeout).
 */

import type { LessonContent } from './blocks';
import { stripMarkdown } from './readability';

// ── Script builder ────────────────────────────────────────────────────────────

const TTS_CHAR_LIMIT = 4500; // safety guard — truncate at sentence boundary before this

/**
 * Build a plain-text TTS script from lesson content + objective.
 * Deterministic: same input → same output.
 */
export function buildNarrationScript(
  content: Omit<LessonContent, 'openerItems'>,
  objective: string,
): string {
  const parts: string[] = [];

  // Objective sentence (always first)
  if (objective.trim()) {
    parts.push(`In this lesson: ${objective.trim()}.`);
  }

  // Article blocks: heading + stripped markdown body
  for (const block of content.blocks) {
    if (block.type === 'article') {
      const heading = block.heading?.trim();
      const body = stripMarkdown(block.markdown ?? '').trim();
      if (heading) parts.push(heading + '.');
      if (body) parts.push(body);
    } else if (block.type === 'glossary_callout') {
      const term = block.term?.trim();
      const def = block.definition?.trim();
      if (term && def) {
        parts.push(`${term}: ${def}`);
      }
    }
    // quiz, flashcard_deck, worked_example, animated_diagram — intentionally skipped
  }

  // Closer — invites learner to try practice questions
  parts.push('Now try the practice questions on screen.');

  const full = parts.join(' ');

  // Truncate at sentence boundary if over limit
  if (full.length <= TTS_CHAR_LIMIT) return full;

  // Find last sentence boundary ('. ', '! ', '? ') at or before the limit
  // This ensures TTS receives a well-formed, complete thought.
  const slice = full.slice(0, TTS_CHAR_LIMIT);
  const lastSentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (lastSentenceEnd > 0) {
    return full.slice(0, lastSentenceEnd + 1).trim();
  }
  // No sentence boundary found — return the raw slice as fallback
  return slice.trim();
}

// ── Silent WAV builder ────────────────────────────────────────────────────────
//
// Standard RIFF/WAVE format: 44-byte header + raw PCM int16 samples.
//   Channels: 1 (mono), SampleRate: 44100, BitsPerSample: 16
//   1 second = 44100 samples × 2 bytes = 88200 bytes of audio data.
//
// Header layout (all little-endian):
//   [0]  'RIFF'  (4 bytes)
//   [4]  chunkSize = 36 + dataSize (4 bytes LE)
//   [8]  'WAVE'  (4 bytes)
//   [12] 'fmt '  (4 bytes)
//   [16] subchunk1Size = 16 (4 bytes LE)
//   [20] audioFormat = 1 (PCM) (2 bytes LE)
//   [22] numChannels = 1 (2 bytes LE)
//   [24] sampleRate = 44100 (4 bytes LE)
//   [28] byteRate = 44100 * 1 * 2 = 88200 (4 bytes LE)
//   [32] blockAlign = 1 * 2 = 2 (2 bytes LE)
//   [34] bitsPerSample = 16 (2 bytes LE)
//   [36] 'data' (4 bytes)
//   [40] subchunk2Size = 88200 (4 bytes LE)
//   [44..] 88200 bytes of zeroed int16 samples

const SAMPLE_RATE = 44100;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const DATA_SIZE = SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE; // 88200
const CHUNK_SIZE = 36 + DATA_SIZE;

/**
 * Build a valid 1-second silent WAV Buffer (pure function, no I/O).
 * Used in fake mode: AI_FAKE_LLM=1 or no OPENAI_API_KEY.
 */
export function buildSilentWav(): Buffer {
  const buf = Buffer.alloc(44 + DATA_SIZE, 0);

  // RIFF chunk descriptor
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(CHUNK_SIZE, 4);
  buf.write('WAVE', 8, 'ascii');

  // fmt sub-chunk
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);              // PCM subchunk1 size
  buf.writeUInt16LE(1, 20);              // audioFormat = 1 (PCM)
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE, 28); // byteRate
  buf.writeUInt16LE(NUM_CHANNELS * BYTES_PER_SAMPLE, 32);                // blockAlign
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // data sub-chunk
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(DATA_SIZE, 40);
  // bytes 44..44+DATA_SIZE are already zeroed by Buffer.alloc

  return buf;
}

// ── TTS synthesis ─────────────────────────────────────────────────────────────

export class TtsSynthesisError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TtsSynthesisError';
  }
}

/**
 * Synthesize audio from a TTS script.
 *
 * Fake mode: AI_FAKE_LLM=1 or OPENAI_API_KEY is absent → 1-second silent WAV.
 * Real mode: POST https://api.openai.com/v1/audio/speech (gpt-4o-mini-tts, alloy voice).
 *
 * Returns { buffer, mimeType }.
 */
export type NarrationMimeType = 'audio/wav' | 'audio/mpeg';

export async function synthesizeNarration(
  script: string,
): Promise<{ buffer: Buffer; mimeType: NarrationMimeType }> {
  const isFake = process.env.AI_FAKE_LLM === '1' || !process.env.OPENAI_API_KEY;
  if (isFake) {
    return { buffer: buildSilentWav(), mimeType: 'audio/wav' };
  }

  const controller = new AbortController();
  // The timer guards the whole exchange, including the body download — headers
  // can arrive long before a multi-MB mp3 finishes streaming.
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          voice: 'alloy',
          input: script,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError' ? 'TTS request timed out' : 'TTS request failed';
      throw new TtsSynthesisError(msg);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TtsSynthesisError(`TTS API error: ${res.status} ${body.slice(0, 200)}`, res.status);
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await res.arrayBuffer();
    } catch (err) {
      const msg =
        err instanceof Error && err.name === 'AbortError' ? 'TTS response download timed out' : 'TTS download failed';
      throw new TtsSynthesisError(msg);
    }
    return { buffer: Buffer.from(arrayBuffer), mimeType: 'audio/mpeg' };
  } finally {
    clearTimeout(timeout);
  }
}
