/**
 * Shared e2e helpers — extracted from onboarding.spec.ts.
 *
 * signUpAndOnboard: drives the full signup → mission interview → map build →
 * calibration quiz flow and returns {email, trackUrl} so callers can navigate
 * to the lesson or other authenticated pages.
 */

import type { Page } from '@playwright/test';

/**
 * Sign up a new user, complete the mission interview, go through calibration,
 * and land on the track page with a built learning map.
 *
 * @returns { email, trackUrl } — the email used and the final /tracks/[id] URL
 */
export async function signUpAndOnboard(page: Page): Promise<{ email: string; trackUrl: string }> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@t.dev`;

  // ── 1. Signup ────────────────────────────────────────────────
  await page.goto('/signup');
  await page.waitForLoadState('networkidle');
  await expect(page.getByLabel('Birth year')).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Birth year').selectOption('1990');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByLabel('Your name')).toBeVisible({ timeout: 10_000 });

  await page.getByLabel('Your name').fill('E2E Learner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-strong-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/tracks/, { timeout: 15_000 });

  // ── 2. New track ─────────────────────────────────────────────
  await page.goto('/tracks/new');
  await page.getByTestId('topic-input').fill('Python CLI tools');
  await page.getByTestId('topic-start').click();

  // ── 3. Interview stepper ─────────────────────────────────────
  await page.getByTestId('why-input').fill('Ship a CLI to my team');
  await page.getByTestId('interview-next').click();

  await expect(page.getByTestId('step-criterion-input-0')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('step-criterion-input-0').fill('Publish a CLI my team installs');
  await page.getByTestId('interview-next').click();

  // Constraints step
  await page.getByTestId('interview-next').click();

  // Prior knowledge
  await page.getByTestId('prior-input').fill('I know Python basics');
  await page.getByTestId('interview-next').click();

  // Out of scope (skip)
  await page.getByTestId('interview-next').click();

  // Mission card — confirm
  await expect(page.getByTestId('interview-confirm')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('interview-confirm').click();

  // ── 4. Track page ─────────────────────────────────────────────
  await expect(page).toHaveURL(/\/tracks\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('build-status')).toBeVisible({ timeout: 10_000 });

  // ── 5. Calibration quiz ──────────────────────────────────────
  await expect(page.getByTestId('quiz-option-0')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('quiz-option-0')).toContainText('Stores a value under a name');
  await page.getByTestId('quiz-option-0').click();

  await expect(page.getByTestId('quiz-option-0')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('quiz-option-0')).toContainText('Repeat work without copy-pasting code');
  await page.getByTestId('quiz-option-0').click();

  // ── 6. Map ready ──────────────────────────────────────────────
  await expect(page.getByTestId('map-summary')).toBeVisible({ timeout: 15_000 });

  const trackUrl = page.url();
  return { email, trackUrl };
}

// Re-export expect so callers don't need to import it separately when using this module.
// (The Page import already pulls in the expect from @playwright/test implicitly via page actions.)
import { expect } from '@playwright/test';
export { expect };
