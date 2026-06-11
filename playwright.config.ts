import { defineConfig } from '@playwright/test';
import { config as dotenvConfig } from 'dotenv';

// Load .env so TEST_DATABASE_URL is available locally (Playwright doesn't auto-load .env)
dotenvConfig({ path: '.env' });
dotenvConfig({ path: '.env.local', override: true });

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:3100' },
  workers: 1, // no parallelism — multiple specs share one server; avoids debounce collisions and auth-state races
  webServer: {
    command: 'npm run dev -- --port 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    env: {
      AI_FAKE_LLM: '1',
      // e2e writes through the app's own DATABASE_URL — point it at the test DB.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      BETTER_AUTH_URL: 'http://localhost:3100',
    },
    timeout: 120_000,
  },
});
