/**
 * Playwright global setup: warm the dev server's heaviest routes before any
 * spec runs. On cold CI runners, Turbopack compiles each route on first hit;
 * without this, the first navigation in a spec can eat its assertion timeout
 * compiling /signup or /tracks (observed CI flake, 2026-06-11).
 *
 * Fetching through auth redirects is fine — the point is compilation, not the
 * response body.
 */
import type { FullConfig } from '@playwright/test';

const WARM_ROUTES = ['/', '/signup', '/login', '/tracks', '/reviews', '/billing', '/privacy', '/terms', '/learn/x/warm-00000000'];

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://localhost:3100';
  for (const route of WARM_ROUTES) {
    try {
      await fetch(`${baseURL}${route}`, { redirect: 'manual' });
    } catch {
      // Server not up yet for local `reuseExistingServer` edge — specs will
      // still pass on warm servers; this is best-effort.
    }
  }
}
