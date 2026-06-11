/**
 * Phase 8 e2e acceptance spec.
 *
 * Covers Goal 4 UI acceptance:
 *   1. On the lesson page, click `listen-button` → `lesson-audio` appears +
 *      `narration-transcript` is present (TTS narration round-trip).
 *   2. On the track page, upload a small .txt file → `upload-item` appears
 *      (text upload → UploadContext shows the uploaded file).
 *
 * Reuses signUpAndOnboard to complete the full onboarding journey, then
 * clicks start-lesson, waits for the lesson page, and runs the Phase 8
 * UI assertions on top of the established journey state.
 *
 * Design decision: this is a separate spec (not extending onboarding.spec.ts)
 * so the Phase 8 assertions don't add more than ~30 seconds to the existing
 * 90-second onboarding journey. Workers:1 serialises both specs naturally.
 *
 * Uses AI_FAKE_LLM=1 (set in playwright.config.ts webServer env).
 * TTS in fake mode: silent WAV returned immediately — no OpenAI call.
 */

import { test, expect } from '@playwright/test';
import { signUpAndOnboard } from './helpers';

test('Phase 8 — narration listen-button + file upload context', async ({ page }) => {
  // ── 1-6. Signup through calibration (shared helper) ───────────────────────
  const { trackUrl } = await signUpAndOnboard(page);
  await expect(page).toHaveURL(trackUrl);

  // ── Start lesson ──────────────────────────────────────────────────────────
  await expect(page.getByTestId('start-lesson')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('start-lesson').click();

  // ── Lesson page ───────────────────────────────────────────────────────────
  await expect(page).toHaveURL(/\/tracks\/[^/]+\/lessons\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('article-block').first()).toBeVisible({ timeout: 60_000 });

  // ── Phase 8 Goal 1: TTS narration ─────────────────────────────────────────
  //
  // listen-button is rendered on the lesson page (ListenButton component).
  // Click it → POST /api/lessons/[lessonId]/narration (fake mode → silent WAV).
  // On success → lesson-audio appears + narration-transcript is present.

  await expect(page.getByTestId('listen-button')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('listen-button').click();

  // Audio element appears after POST succeeds (fake mode is fast)
  await expect(page.getByTestId('lesson-audio')).toBeVisible({ timeout: 15_000 });

  // Transcript details element is rendered (captions promise)
  // In fake mode the transcript is non-empty, so the <details> renders.
  await expect(page.getByTestId('narration-transcript')).toBeVisible({ timeout: 5_000 });

  // ── Navigate back to track page ──────────────────────────────────────────
  // Use browser back so we land on the track page with the upload panel visible.
  await page.goBack();
  await expect(page).toHaveURL(/\/tracks\/[^/]+$/, { timeout: 10_000 });

  // ── Phase 8 Goal 2: File upload → upload-item ────────────────────────────
  //
  // The UploadContext component is rendered on the track page.
  // Upload a small .txt file using Playwright setInputFiles with an in-memory
  // payload (no temp file needed — Buffer API supported since Playwright 1.18).

  await expect(page.getByTestId('upload-context')).toBeVisible({ timeout: 10_000 });

  // Use setInputFiles with in-memory buffer (no temp file)
  const fileInput = page.locator('#upload-context-input');
  await fileInput.setInputFiles({
    name: 'test-context.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('This is my context note for the lesson about variables.'),
  });

  // upload-item should appear after the upload succeeds
  await expect(page.getByTestId('upload-item')).toBeVisible({ timeout: 20_000 });
});
