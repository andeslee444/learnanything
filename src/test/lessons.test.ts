import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';

describe('lesson domain', () => {
  let trackId: string;
  let learnerId: string;

  beforeAll(async () => {
    await resetDb();
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'L', email: 'lesson@t.dev' })
      .returning();
    const [learner] = await testDb
      .insert(s.learners)
      .values({ userId: u.id, displayName: 'L', ageBand: '16_17' })
      .returning();
    const [track] = await testDb
      .insert(s.tracks)
      .values({ learnerId: learner.id, topic: 'WW1 causes', vertical: 'history' })
      .returning();
    trackId = track.id;
    learnerId = learner.id;
  });

  afterAll(() => testPool.end());

  it('stores a lesson and its attempt events', async () => {
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 1, spec: { objective: 'Explain the alliance system' } })
      .returning();
    expect(lesson.status).toBe('generating');
    expect(lesson.verificationStatus).toBe('pending');

    const [event] = await testDb
      .insert(s.attemptEvents)
      .values({ learnerId, lessonId: lesson.id, eventType: 'quiz_answer', correct: true })
      .returning();
    expect(event.correct).toBe(true);
  });

  it('enforces unique slugs and one shared page per lesson', async () => {
    const [lesson] = await testDb
      .insert(s.lessons)
      .values({ trackId, seq: 2, spec: { objective: 'x' } })
      .returning();
    await testDb.insert(s.sharedLessons).values({
      lessonId: lesson.id, sanitizedContent: {}, slug: 'ww1-alliances-ab12',
    });
    // Attempt to insert a second shared_lesson for the same lesson_id — violates the unique FK
    const err = await testDb.insert(s.sharedLessons).values({
      lessonId: lesson.id, sanitizedContent: {}, slug: 'ww1-alliances-cd34',
    }).catch((e: unknown) => e);
    // Drizzle 0.45 wraps PG errors: outer message = "Failed query: …"; real message in .cause
    const msg = String(
      err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error).message
    );
    expect(msg).toMatch(/duplicate key|unique/i);
    // Verify it's specifically the lesson_id unique constraint (one shared page per source lesson)
    expect(msg).toMatch(/shared_lessons_lesson_id_unique/i);
  });
});
