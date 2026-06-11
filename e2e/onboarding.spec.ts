import { test, expect } from '@playwright/test';
import { signUpAndOnboard } from './helpers';

/**
 * Full onboarding → first lesson happy path:
 * signup (birth year 1990) → /tracks/new → mission interview
 * → confirm card → build status → calibration quiz → map
 * → start lesson → lesson page → article/quiz/win-check → complete
 * → back to track → lesson-card + node under Done
 *
 * Uses AI_FAKE_LLM=1 (set in playwright.config.ts webServer env) so no real
 * model calls happen. Single worker ensures no debounce collisions.
 *
 * The signup→onboard→map portion is extracted into signUpAndOnboard (e2e/helpers.ts)
 * and shared with the a11y spec — behavior is identical.
 */
test('signup → mission interview → learning map → calibration → lesson journey', async ({ page }) => {
  // ── 1-6. Signup through calibration (shared helper) ──────────
  const { trackUrl } = await signUpAndOnboard(page);

  // Navigate back to track URL (helper lands here but let's assert URL)
  await expect(page).toHaveURL(trackUrl);

  // ── 6 cont. Map assertions ────────────────────────────────────
  await expect(page.getByTestId('map-node').filter({ hasText: 'Variables and types' })).toBeVisible();

  // Start lesson button appears when nodes exist and no lesson is generating
  await expect(page.getByTestId('start-lesson')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('start-lesson').click();

  // ── 7. Lesson page ───────────────────────────────────────────
  await expect(page).toHaveURL(/\/tracks\/[^/]+\/lessons\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('article-block').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Variables: names for values')).toBeVisible({ timeout: 10_000 });

  // ── 7b. Verification badges ───────────────────────────────────
  await expect.poll(
    async () => {
      const count = await page.locator('[data-testid="verify-badge"][data-verify-status="verified"]').count();
      return count;
    },
    { timeout: 30_000, intervals: [1_000] },
  ).toBeGreaterThanOrEqual(1);

  // ── 7c. Tutor panel ──────────────────────────────────────────
  await expect(page.getByTestId('tutor-panel')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('tutor-panel').getByRole('button', { name: /Ask the AI tutor/ }).click();
  await expect(page.getByTestId('tutor-input')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('tutor-input').fill('What does the box metaphor mean?');
  await page.getByTestId('tutor-send').click();
  await expect(page.getByText(/Think about what the box holds/)).toBeVisible({ timeout: 15_000 });

  // ── 8. Body quiz: q1 ─────────────────────────────────────────
  await expect(page.getByText('After `count = 3`, what does reading `count` give you?')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Option 1: 3' }).click();

  // ── 8b. FlashcardDeck ────────────────────────────────────────
  await expect(page.getByTestId('flashcard-deck')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('flashcard-deck')).toContainText('card 1 of 3');
  await page.getByTestId('flashcard-flip').click();
  await expect(page.getByTestId('flashcard-deck')).toContainText('Back');
  await page.getByTestId('flashcard-next').click();
  await expect(page.getByTestId('flashcard-deck')).toContainText('card 2 of 3');

  // ── 8c. WorkedExample ────────────────────────────────────────
  await expect(page.getByTestId('worked-example')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('we-show-next-step').click();
  await expect(page.getByTestId('we-step-0')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('we-show-next-step').click();
  await expect(page.getByTestId('we-step-1')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('we-show-next-step').click();
  await expect(page.getByTestId('we-step-2')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('we-option-0')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('we-option-0')).toContainText('count holds 7');
  await page.getByTestId('we-option-0').click();

  // ── 8d. AnimatedDiagram ──────────────────────────────────────
  await expect(page.getByTestId('animated-diagram')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('animated-diagram')).toContainText(
    'Start with the value 5 on the right-hand side of the assignment.'
  );
  await page.getByTestId('diagram-step').click();
  await expect(page.getByTestId('animated-diagram')).toContainText(
    'The assignment operator copies 5 into the variable count'
  );

  // ── 9. Win-check ─────────────────────────────────────────────
  await expect(page.getByTestId('win-check')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('win-check').getByRole('button', { name: /Option 1: Stores a value under a name/ }).click();
  await expect(page.getByTestId('win-check').getByRole('button', { name: /Option 1: 7/ })).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('win-check').getByRole('button', { name: /Option 1: 7/ }).click();

  // ── 10. Lesson complete ───────────────────────────────────────
  await expect(page.getByTestId('lesson-complete')).toBeVisible({ timeout: 15_000 });

  // ── 11. Back to track page ────────────────────────────────────
  await page.getByTestId('lesson-complete').getByRole('link', { name: /back to learning map/i }).click();
  await expect(page).toHaveURL(/\/tracks\/[^/]+$/, { timeout: 15_000 });

  await expect(page.getByTestId('lesson-card')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Done')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('map-node').filter({ hasText: 'Variables and types' })).toBeVisible();

  // ── 12. Library link ──────────────────────────────────────────
  await expect(page.getByTestId('library-link')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('library-link').click();
  await expect(page).toHaveURL(/\/tracks\/[^/]+\/library$/, { timeout: 15_000 });

  // ── 13. Library page ─────────────────────────────────────────
  await expect(page.getByTestId('library')).toBeVisible({ timeout: 10_000 });

  await expect.poll(
    async () => {
      const count = await page.getByTestId('glossary-term').count();
      if (count === 0) await page.reload();
      return count;
    },
    { timeout: 15_000 },
  ).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('glossary-term').filter({ hasText: 'variable' })).toBeVisible();

  await expect(page.getByTestId('reference-doc-card').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('record-item').first()).toBeVisible({ timeout: 10_000 });

  // ── 14. Header reviews-badge ─────────────────────────────────
  await expect.poll(
    async () => {
      const badge = await page.getByTestId('reviews-badge').count();
      if (badge === 0) await page.reload();
      return badge;
    },
    { timeout: 15_000 },
  ).toBeGreaterThanOrEqual(1);

  // ── 15. /reviews page ────────────────────────────────────────
  await page.getByTestId('reviews-badge').click();
  await expect(page).toHaveURL(/\/reviews$/, { timeout: 10_000 });
  await expect(page.getByTestId('review-card')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /A named container for a value\./ }).click();

  // ── 16. Reviews done ─────────────────────────────────────────
  await expect(page.getByTestId('reviews-done')).toBeVisible({ timeout: 10_000 });
});
