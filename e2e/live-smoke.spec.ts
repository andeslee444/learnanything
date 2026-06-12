/**
 * Live production smoke test — NOT part of the CI battery.
 *
 * Runs against a deployed instance (real LLM calls, real money — pennies):
 *   npx playwright test -c e2e/live-smoke.config.ts
 *
 * Differences from the fake-mode e2e:
 *   - Text-agnostic assertions (live content is model-generated, not fixtures).
 *   - Long timeouts: skill-graph build is an Opus call (~30-60s); lesson
 *     generation with cold research is 1-3 min by design (spec §1 latency policy).
 *   - Self-cleaning: deletes the smoke account (cascade) at the end, so the
 *     production DB keeps no test artifacts.
 */

import { test, expect } from '@playwright/test';

test('live smoke: signup → track → live lesson generation starts → account delete', async ({ page }) => {
  test.setTimeout(420_000);
  const email = `smoke-${Date.now()}@learnanything-smoke.dev`;

  // ── 1. Public pages up ─────────────────────────────────────────
  await page.goto('/');
  await expect(page.getByTestId('footer-privacy')).toBeVisible({ timeout: 30_000 });

  // ── 2. Signup (age screen → account) ───────────────────────────
  await page.goto('/signup');
  await page.getByLabel('Birth year').selectOption('1990');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Smoke Test');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(`sm0ke-${Date.now()}!aB`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/tracks/, { timeout: 30_000 });

  // ── 3. Track + mission interview (live moderation = real Haiku call) ──
  await page.goto('/tracks/new');
  await page.getByTestId('topic-input').fill('Python variables for beginners');
  await page.getByTestId('topic-start').click();
  await page.getByTestId('why-input').fill('Smoke-testing the deployed pipeline');
  await page.getByTestId('interview-next').click();
  await expect(page.getByTestId('step-criterion-input-0')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('step-criterion-input-0').fill('Explain variables to a colleague');
  await page.getByTestId('interview-next').click();
  await page.getByTestId('interview-next').click(); // constraints (skip)
  await page.getByTestId('prior-input').fill('Total beginner');
  await page.getByTestId('interview-next').click();
  await page.getByTestId('interview-next').click(); // out of scope (skip)
  await expect(page.getByTestId('interview-confirm')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('interview-confirm').click();

  // ── 4. Live skill-graph build (Opus) + calibration ─────────────
  await expect(page).toHaveURL(/\/tracks\/[^/]+$/, { timeout: 30_000 });
  // Answer whatever calibration items appear — content is model-generated,
  // so click option 0 each round until the map summary lands.
  await expect(page.getByTestId('quiz-option-0')).toBeVisible({ timeout: 120_000 });
  for (let i = 0; i < 6; i++) {
    if (await page.getByTestId('map-summary').isVisible().catch(() => false)) break;
    const opt = page.getByTestId('quiz-option-0');
    if (await opt.isVisible().catch(() => false)) await opt.click();
    await page.waitForTimeout(1_500);
  }
  await expect(page.getByTestId('map-summary')).toBeVisible({ timeout: 60_000 });

  // ── 5. Start a live lesson — proves Workflow DevKit + gateway OIDC + Exa ──
  // We assert generation STARTS and produces visible progress; full delivery
  // (1-3 min cold research) is awaited with the spec's latency budget.
  const startLesson = page.getByTestId('start-lesson');
  await startLesson.click();
  await expect(page.getByTestId('lesson-generating').or(page.getByTestId('lesson-outline'))).toBeVisible({
    timeout: 60_000,
  });
  // Outline streams first (plan stage needs only track state — ≤ ~5s budget,
  // generous here); first blocks within the cold-miss budget.
  await expect(page.getByTestId('lesson-outline').or(page.getByTestId('article-block'))).toBeVisible({
    timeout: 240_000,
  });

  // ── 6. Self-clean: delete the smoke account (cascade) ──────────
  await page.goto('/billing');
  await page.getByTestId('delete-confirm').fill('DELETE');
  await page.getByTestId('delete-account').click();
  await expect(page).toHaveURL(/\/$|\/login/, { timeout: 30_000 });
});
