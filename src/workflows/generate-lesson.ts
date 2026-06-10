import { getWritable } from 'workflow';
import { runLessonStage } from '@/server/lessons/pipeline';

export type ProgressStage = 'planned' | 'researched' | 'generating' | 'ready' | 'failed';
export type ProgressEvent = { stage: ProgressStage; at: number };

async function emitProgress(stage: ProgressStage) {
  'use step';
  const writable = getWritable<ProgressEvent>();
  const writer = writable.getWriter();
  try {
    await writer.write({ stage, at: Date.now() });
  } finally {
    writer.releaseLock();
  }
}

async function plan(lessonId: string) {
  'use step';
  return runLessonStage('plan', lessonId);
}
async function research(lessonId: string) {
  'use step';
  return runLessonStage('research', lessonId);
}
async function generate(lessonId: string) {
  'use step';
  return runLessonStage('generate', lessonId);
}
async function markFailed(lessonId: string, message: string) {
  'use step';
  return runLessonStage('fail', lessonId, message);
}

export async function generateLessonWorkflow(lessonId: string) {
  'use workflow';
  try {
    const planned = await plan(lessonId);
    await emitProgress(planned.status === 'planned' ? 'planned' : 'failed');
    if (planned.status !== 'planned') return planned;
    const researched = await research(lessonId);
    await emitProgress(researched.status === 'researched' ? 'researched' : 'failed');
    if (researched.status !== 'researched') return researched;
    await emitProgress('generating');
    const result = await generate(lessonId);
    await emitProgress(result.status === 'ready' ? 'ready' : 'failed');
    return result;
  } catch {
    await emitProgress('failed');
    return markFailed(lessonId, 'generation error — try again');
  }
}
