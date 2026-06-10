import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as schema from '@/db/schema';

const testAuth = betterAuth({
  database: drizzleAdapter(testDb, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true },
  secret: 'test-secret-test-secret-test-secret',
  baseURL: 'http://localhost:3000',
});

describe('better-auth signup', () => {
  beforeAll(resetDb);
  afterAll(() => testPool.end());

  it('creates a user row on email signup', async () => {
    await testAuth.api.signUpEmail({
      body: { name: 'Test Learner', email: 'test@example.com', password: 'a-strong-password-123' },
    });
    const rows = await testDb
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'test@example.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Test Learner');
  });
});
