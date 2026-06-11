/**
 * Phase 10 e2e acceptance spec.
 *
 * ONE journey reusing signUpAndOnboard:
 *
 * 1. Complete onboarding → land on track page.
 * 2. Open the lesson (wait for article-block ready).
 * 3. Click share-lesson → share-url visible, capture the public path.
 * 4. In a NEW browser context (logged-out), visit the public URL:
 *    - public-lesson visible
 *    - public-badges present
 *    - make-it-yours present + navigates to /signup when clicked
 *    - report-lesson present → click → pick a reason → thanks state.
 * 5. Back in owner context: click unshare-lesson → public URL now 404s
 *    (page.goto → expect not-found content).
 *
 * Design decisions:
 *   - Single journey; sub-checks share journey state for efficiency.
 *   - Public page first-hit is dynamic (DB read + Turbopack compile).
 *     Use generous timeout (90s) on the first visit.
 *   - Workers:1 serialises all specs.
 *   - Fake LLM (AI_FAKE_LLM=1) — set in playwright.config.ts.
 *   - /learn/[vertical]/[slug] is dynamic — warn the global-setup about it;
 *     we accept first-hit compile budget with the generous timeout.
 */

import { test, expect } from '@playwright/test';
import { signUpAndOnboard } from './helpers';

test('Phase 10 — share journey: share → public page (badges, make-it-yours, report) → unshare → 404', async ({
  page,
  browser,
}) => {
  // ── 1. Signup + onboarding ─────────────────────────────────────────────────
  const { trackUrl } = await signUpAndOnboard(page);
  await expect(page).toHaveURL(trackUrl);

  // ── 2. Open the lesson ─────────────────────────────────────────────────────
  await expect(page.getByTestId('start-lesson')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('start-lesson').click();

  // Wait for the lesson page to load (article-block indicates content is ready)
  await expect(page).toHaveURL(/\/tracks\/[^/]+\/lessons\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('article-block').first()).toBeVisible({ timeout: 60_000 });

  // ── 3. Click share-lesson ──────────────────────────────────────────────────
  await expect(page.getByTestId('share-lesson')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('share-lesson').click();

  // Wait for share-url to appear (POST /api/lessons/[id]/share completes)
  await expect(page.getByTestId('share-url')).toBeVisible({ timeout: 30_000 });

  // Capture the public path from the share-url link href
  const shareUrlElement = page.getByTestId('share-url');
  const shareHref = await shareUrlElement.getAttribute('href');
  expect(shareHref).toBeTruthy();
  expect(shareHref).toMatch(/^\/learn\/[a-z]+\/[a-z0-9-]+-[a-z0-9]{8}$/);

  // Full public URL for navigation
  const baseURL = 'http://localhost:3100';
  const publicURL = `${baseURL}${shareHref}`;

  // ── 4. Visit public URL in a new browser context (logged out) ───────────────
  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();

  try {
    // First hit may be cold (dynamic compile) — use generous timeout
    await publicPage.goto(publicURL, { timeout: 90_000 });

    // public-lesson element present
    await expect(publicPage.getByTestId('public-lesson')).toBeVisible({ timeout: 30_000 });

    // public-badges present
    await expect(publicPage.getByTestId('public-badges')).toBeVisible({ timeout: 10_000 });

    // Badge may show 'Verification in progress' (no verification run in e2e) or a status
    // Either the status text or the 'Verification in progress' fallback renders in the badge panel
    await expect(publicPage.getByTestId('public-badges')).toContainText(/verification/i, { timeout: 5_000 });

    // make-it-yours CTA present
    await expect(publicPage.getByTestId('make-it-yours')).toBeVisible({ timeout: 10_000 });

    // Clicking make-it-yours navigates to /signup
    await publicPage.getByTestId('make-it-yours').click();
    await expect(publicPage).toHaveURL(/\/signup$/, { timeout: 10_000 });

    // Go back to the public lesson page
    await publicPage.goBack();
    await expect(publicPage.getByTestId('public-lesson')).toBeVisible({ timeout: 10_000 });

    // report-lesson button present
    await expect(publicPage.getByTestId('report-lesson')).toBeVisible({ timeout: 10_000 });

    // Click report → opens reason picker dialog
    await publicPage.getByTestId('report-lesson').click();

    // Reason picker visible (radio buttons for inaccurate / inappropriate / copyright / other)
    await expect(publicPage.getByRole('radio', { name: /inaccurate/i })).toBeVisible({ timeout: 10_000 });

    // Pick a reason
    await publicPage.getByRole('radio', { name: /inaccurate/i }).click();

    // Click submit
    await publicPage.getByRole('button', { name: /submit report/i }).click();

    // Thanks state: report-lesson element now shows thank-you text
    await expect(publicPage.getByTestId('report-lesson')).toContainText(
      /thank you/i,
      { timeout: 10_000 },
    );
  } finally {
    await publicContext.close();
  }

  // ── 5. Owner unshares — public URL now 404s ───────────────────────────────
  //
  // Navigate back to owner's lesson page (still in the original browser context)
  await expect(page.getByTestId('unshare-lesson')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('unshare-lesson').click();

  // After unshare, the share-lesson button returns (idle state)
  await expect(page.getByTestId('share-lesson')).toBeVisible({ timeout: 10_000 });

  // Now verify the public URL returns 404/not-found
  // Open the public URL again in a fresh context — it should no longer resolve
  const checkContext = await browser.newContext();
  const checkPage = await checkContext.newPage();

  try {
    const response = await checkPage.goto(publicURL, { timeout: 30_000 });

    // Next.js notFound() returns a 404 status. Check either the status code
    // OR the presence of a not-found indicator in the page content.
    // The (learn) layout has no auth gate — notFound() renders the 404 page directly.
    if (response) {
      const status = response.status();
      if (status === 404) {
        // Direct 404 status — test passes
        expect(status).toBe(404);
      } else {
        // Some frameworks render a 200 with not-found content — check page text
        const bodyText = await checkPage.textContent('body');
        expect(bodyText).toMatch(/not found|404|this page could not be found/i);
      }
    }
  } finally {
    await checkContext.close();
  }
});
