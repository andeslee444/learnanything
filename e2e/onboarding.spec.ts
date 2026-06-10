import { test, expect } from '@playwright/test';

/**
 * Full onboarding → first lesson happy path:
 * signup (birth year 1990) → /tracks/new → mission interview
 * → confirm card → build status → calibration quiz → map
 * → start lesson → lesson page → article/quiz/win-check → complete
 * → back to track → lesson-card + node under Done
 *
 * Uses AI_FAKE_LLM=1 (set in playwright.config.ts webServer env) so no real
 * model calls happen. Single worker ensures no debounce collisions.
 */
test('signup → mission interview → learning map → calibration → lesson journey', async ({ page }) => {
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

  // ── 6. Map: start-lesson button ──────────────────────────────
  // After last quiz answer, router.refresh() brings the server component back
  // with nodes and the lesson section (including start-lesson button)
  await expect(page.getByTestId('map-summary')).toBeVisible({ timeout: 15_000 });
  // Fixture graph node "Variables and types" should appear (Up next group, not yet mastered)
  await expect(page.getByTestId('map-node').filter({ hasText: 'Variables and types' })).toBeVisible();

  // Start lesson button appears when nodes exist and no lesson is generating
  await expect(page.getByTestId('start-lesson')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('start-lesson').click();

  // ── 7. Lesson page ───────────────────────────────────────────
  // After click, router.push → /tracks/[id]/lessons/[lessonId]
  await expect(page).toHaveURL(/\/tracks\/[^/]+\/lessons\/[^/]+$/, { timeout: 15_000 });

  // The workflow may complete very fast in fake mode (pipeline is synchronous-ish)
  // OR may briefly show lesson-generating. Either way: wait for article-block.
  // Generous 60s timeout covers both paths (generating → polling → ready transition).
  await expect(page.getByTestId('article-block').first()).toBeVisible({ timeout: 60_000 });

  // Optionally assert generating panel IF still visible at some point
  // (not required — the workflow may deliver before the first poll)

  // Fixture heading from 'generate-lesson' fixture
  await expect(page.getByText('Variables: names for values')).toBeVisible({ timeout: 10_000 });

  // ── 8. Body quiz: q1 ─────────────────────────────────────────
  // No opener items — this e2e learner has no glossary terms at lesson #1
  // (glossary is seeded by research extraction; the e2e uses fake mode which
  //  doesn't persist glossary terms before the first lesson)
  //
  // The lesson renders fast in fake mode; quiz block and win-check may both be
  // on the page simultaneously. Scope to the quiz block to avoid strict-mode
  // violations (both components share the quiz-option-* testid pattern).
  //
  // Fixture q1: 'After `count = 3`, what does reading `count` give you?'
  // Options: ['3', 'The text "count"', 'Nothing', 'An error'], correctIndex: 0 → '3'
  //
  // Look for the question text first, then click the option within it.
  // The article block is already visible so the quiz block should be rendered.
  await expect(page.getByText('After `count = 3`, what does reading `count` give you?')).toBeVisible({ timeout: 10_000 });
  // Click the first option button that contains just '3' (exact match scoped to body quiz).
  // Use .first() to resolve any strict mode conflict — the body quiz option appears before win-check.
  await page.getByRole('button', { name: 'Option 1: 3' }).click();

  // ── 9. Win-check: wc1 ────────────────────────────────────────
  // After the body quiz q1 is answered, win-check is already rendered.
  // wc1: 'What does a variable do?'
  // wc1 options: ['Stores a value under a name', 'Draws on screen', ...], correctIndex: 0
  await expect(page.getByTestId('win-check')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('win-check').getByRole('button', { name: /Option 1: Stores a value under a name/ }).click();

  // Win-check advances to wc2 after ~1800ms state transition.
  // wc2: 'After `x = 5` then `x = 7`, what is x?'
  // Options: ['7', '5', '12', 'Both 5 and 7'], correctIndex: 0 → '7'
  await expect(page.getByTestId('win-check').getByRole('button', { name: /Option 1: 7/ })).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('win-check').getByRole('button', { name: /Option 1: 7/ }).click();

  // ── 10. Lesson complete ───────────────────────────────────────
  // Both win-check items answered correctly → passed → lesson-complete panel
  await expect(page.getByTestId('lesson-complete')).toBeVisible({ timeout: 15_000 });

  // ── 11. Back to track page ────────────────────────────────────
  // Use the "Back to learning map" link inside the lesson-complete panel
  // (the lesson page also has a "← Back to learning map" nav link — use the panel one).
  await page.getByTestId('lesson-complete').getByRole('link', { name: /back to learning map/i }).click();
  await expect(page).toHaveURL(/\/tracks\/[^/]+$/, { timeout: 15_000 });

  // Lesson card now visible (at least one lesson exists)
  await expect(page.getByTestId('lesson-card')).toBeVisible({ timeout: 10_000 });

  // 'Variables and types' node now appears under Done (mastery=demonstrated after win-check pass)
  // The track page groups by mastery — demonstrated/mastered → 'done' group labeled "Done"
  await expect(page.getByText('Done')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('map-node').filter({ hasText: 'Variables and types' })).toBeVisible();
});
