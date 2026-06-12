/**
 * Standalone config for the live production smoke test.
 *
 *   LIVE_SMOKE_URL=https://learnanything-opal.vercel.app \
 *     npx playwright test -c e2e/live-smoke.config.ts
 *
 * No webServer — runs against a deployed instance with REAL LLM calls.
 * Deliberately excluded from the CI battery (playwright.config.ts testIgnore).
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'live-smoke.spec.ts',
  timeout: 420_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.LIVE_SMOKE_URL ?? 'https://learnanything-opal.vercel.app',
  },
});
