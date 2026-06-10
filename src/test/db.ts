import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';

export const testPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
export const testDb = drizzle(testPool, { schema });

/** Truncate all app tables between test files. Skips drizzle's migration bookkeeping. */
export async function resetDb() {
  const tables = await testDb.execute(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '__drizzle%'
  `);
  for (const row of tables.rows as { tablename: string }[]) {
    await testDb.execute(
      sql.raw(`TRUNCATE TABLE "${row.tablename}" RESTART IDENTITY CASCADE`)
    );
  }
}
