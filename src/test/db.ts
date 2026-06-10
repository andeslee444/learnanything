import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';

// Each test file that imports testPool MUST call afterAll(() => testPool.end())
// to avoid open-handle warnings. Vitest isolates modules per file, so each
// file gets its own Pool instance.
export const testPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
export const testDb = drizzle(testPool, { schema });

/** Truncate all app tables between test files. Skips drizzle's migration bookkeeping. */
export async function resetDb() {
  const tables = await testDb.execute(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '__drizzle%'
  `);
  if (tables.rows.length === 0) return;
  const names = (tables.rows as { tablename: string }[])
    .map((r) => `"${r.tablename}"`)
    .join(', ');
  await testDb.execute(sql.raw(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`));
}
