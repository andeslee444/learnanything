import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

// migrationsSchema defaults to 'drizzle' (drizzle.__drizzle_migrations) — intentionally not in public
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
