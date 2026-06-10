import { runLessonStage } from '@/server/lessons/pipeline';

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
    if (planned.status !== 'planned') return planned;
    const researched = await research(lessonId);
    if (researched.status !== 'researched') return researched;
    return generate(lessonId);
  } catch {
    return markFailed(lessonId, 'generation error — try again');
  }
}
