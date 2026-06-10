import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import 'dotenv/config';

export default async function setup() {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    try {
      await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    } catch (err) {
      // Task 4 adds the first migration. Until then, the journal file won't exist
      // and drizzle-kit will throw. Ignore that specific error; rethrow anything else.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('journal') && !message.includes('No migrations')) {
        throw err;
      }
    }
  } finally {
    await pool.end();
  }
}
