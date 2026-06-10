import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { testDb, testPool } from './db';

describe('database connection', () => {
  it('answers SELECT 1', async () => {
    const result = await testDb.execute(sql`SELECT 1 AS one`);
    expect(result.rows[0]).toEqual({ one: 1 });
  });
});

afterAll(() => testPool.end());
