import { test, expect } from '@playwright/test';

/**
 * Full onboarding happy path:
 * signup (birth year 1990) → /tracks/new → mission interview
 * → confirm card → build status → calibration quiz → map + lesson stub
 *
 * Uses AI_FAKE_LLM=1 (set in playwright.config.ts webServer env) so no real
 * model calls happen. Single worker ensures no debounce collisions.
 */
test('signup → mission interview → learning map → calibration → stub', async ({ page }) => {
  const email = `e2e-${Date.now()}@t.dev`;

  // ── 1. Signup ────────────────────────────────────────────────
  await page.goto('/signup');
  // Wait for React to fully hydrate (networkidle = no pending network requests)
  await page.waitForLoadState('networkidle');
  await expect(page.getByLabel('Birth year')).toBeVisible({ timeout: 15_000 });

  // Birth year step (aria-label "Birth year" on the select)
  await page.getByLabel('Birth year').selectOption('1990');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Wait for the account form to appear (React state transition from age step)
  await expect(page.getByLabel('Your name')).toBeVisible({ timeout: 10_000 });

  // Account form
  await page.getByLabel('Your name').fill('E2E Learner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-strong-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();

  // Should land on /tracks after signup
  await expect(page).toHaveURL(/\/tracks/, { timeout: 15_000 });

  // ── 2. New track ─────────────────────────────────────────────
  await page.goto('/tracks/new');
  await page.getByTestId('topic-input').fill('Python CLI tools');
  // vertical-select defaults to "programming" — leave it
  await page.getByTestId('topic-start').click();

  // ── 3. Interview stepper ─────────────────────────────────────

  // Step: why
  await page.getByTestId('why-input').fill('Ship a CLI to my team');
  await page.getByTestId('interview-next').click();
  // fixture: concrete=true, followUp=null → no follow-up step, goes straight to success

  // Step: success criteria (step-criterion-input-0 is the first input)
  await expect(page.getByTestId('step-criterion-input-0')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('step-criterion-input-0').fill('Publish a CLI my team installs');
  await page.getByTestId('interview-next').click();

  // Step: constraints (defaults fine, just click Next)
  await page.getByTestId('interview-next').click();

  // Step: prior knowledge
  await page.getByTestId('prior-input').fill('I know Python basics');
  await page.getByTestId('interview-next').click();

  // Step: out of scope (skip — button says "Skip" when no tags added)
  await page.getByTestId('interview-next').click();

  // Step: mission card — confirm
  await expect(page.getByTestId('interview-confirm')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('interview-confirm').click();

  // ── 4. Track page: build status ──────────────────────────────
  // Should redirect to /tracks/[id]
  await expect(page).toHaveURL(/\/tracks\/[^/]+$/, { timeout: 15_000 });

  // Build status spinner visible
  await expect(page.getByTestId('build-status')).toBeVisible({ timeout: 10_000 });

  // ── 5. Calibration quiz ──────────────────────────────────────
  // Fixture quiz item 1: "What does a variable do in a program?"
  // Correct answer (index 0): "Stores a value under a name"
  await expect(page.getByTestId('quiz-option-0')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('quiz-option-0')).toContainText('Stores a value under a name');
  await page.getByTestId('quiz-option-0').click();

  // Fixture quiz item 2: "What is the purpose of a loop?"
  // Correct answer (index 0): "Repeat work without copy-pasting code"
  await expect(page.getByTestId('quiz-option-0')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('quiz-option-0')).toContainText('Repeat work without copy-pasting code');
  await page.getByTestId('quiz-option-0').click();

  // ── 6. Map + lesson stub ─────────────────────────────────────
  // After last quiz answer, router.refresh() brings the server component back
  // with nodes and stub visible
  await expect(page.getByTestId('lesson-stub')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('map-summary')).toBeVisible();
  // Fixture graph node "Variables and types" should appear
  await expect(page.getByTestId('map-node').filter({ hasText: 'Variables and types' })).toBeVisible();
});
