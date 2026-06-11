# Phase 6: Async Verification — Claims, Entailment, Badges

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. All established conventions apply. Architecture prescriptions from the Phase 5 final review are BINDING: multi-step WDK workflow (one LLM call per `'use step'`), per-step idempotency, a new `verification_results` table keyed (lesson_id, block_id) — never mutate lesson content jsonb for badges; deterministic verdict→badge map in code (the judge classifies, never authors learner-visible state); unique-index-first idempotency for the regenerate-once rule; fixtures for all new purposes on day one.

**Goal (= acceptance contract):** Spec §2 step 6 + decision #3 ("cited + continuously verified, badges"). After a lesson is delivered: (1) a verification workflow extracts factual claims per article block, entails each against the dossier's claims/quotes, and writes per-block results; (2) the lesson UI shows per-block badges — `verified` / `checking` / `unverified` — live-updating (poll on the lesson page); (3) a block whose claims fail entailment is regenerated ONCE (validated + moderated like stageGenerate); still-failing blocks render with a visible "couldn't verify" treatment; (4) a per-lesson `faithfulness_score` (verified claims / total claims) is stored and a console-warn alert fires under 0.8 (founder-alert seam); (5) corrections are bounded: verification touches only the lesson at hand (the spec's lazy/bounded re-verification of dossiers on model swaps stays Phase 9+ scope — document).

---

### Task 1: Schema + verdict model

**Files:** `src/db/schema/verification.ts` (new), index export, migration (drizzle-kit generate — proper snapshots!), `src/server/lessons/verdicts.ts` (pure)

- Table `verification_results`: id uuid pk; lessonId FK cascade; blockId text (the block's array index as string — establish `block-{i}` convention, comment it); status enum pgEnum('block_verification_status', ['checking','verified','unverified','regenerated']); claimsTotal int; claimsVerified int; details jsonb (per-claim verdicts [{claim, verdict, sourceUrl?}]); createdAt/updatedAt (+ trigger via custom migration, established pattern); **uniqueIndex on (lessonId, blockId)** — the idempotency backstop.
- Pure verdict model `verdicts.ts`: `badgeFor(claimsVerified, claimsTotal): 'verified'|'unverified'` (verified iff all claims verified AND total ≥1; zero-claim article blocks → 'verified' with total 0 — definitional prose, comment); `faithfulnessScore(results): number` (sum verified / sum total; total 0 → 1.0); `ALERT_THRESHOLD = 0.8`. TDD these.
- Migration replay-verified; full battery; commit.

### Task 2: Claim extraction + entailment purposes

**Files:** `src/server/lessons/verify.ts` (new), purposes/fixtures (`extract-claims`, `entail-claim`), tests

- `extract-claims` (classifier tier): input = ONE article block's markdown (spotlighted `<lesson-block>` tags, data-never-instructions); output `{claims: [{claim ≤300}] (0-8)}` — factual assertions only (definitions/opinions/instructions excluded — prompt states this).
- `entail-claim` (classifier tier): input = one claim + the dossier's claims with quotes (spotlighted); output `{verdict: 'supported'|'unsupported', sourceUrl: string|null, note ≤200}` — supported ONLY if a dossier claim/quote substantively entails it; the LLM picks the supporting sourceUrl from the provided list or null.
- Code guard: a 'supported' verdict whose sourceUrl is not in the dossier's url set → treated as 'unsupported' (deterministic, mirrors the citation guard).
- `verifyBlock(db, {lessonId, blockIndex, modelOverride?})`: load lesson(ready)+dossier (via zpdSnapshot.dossierId) → skip non-article blocks (write status 'verified', total 0? NO — only article blocks get rows at all; comment) → extract → entail each sequentially → upsert verification_results (ON CONFLICT (lessonId,blockId) DO UPDATE) with badgeFor result.
- Fixtures: extract-claims → 2 claims matching the fixture article ("A variable stores a value under a name", "Variables let the same code work with different values"); entail-claim → supported with the python doc url. Tests: round-trip in fake mode; the url-guard both ways; zero-claims path.
- Full battery; commit.

### Task 3: The verification workflow + regenerate-once

**Files:** `src/workflows/verify-lesson.ts` (new), `src/server/lessons/verify.ts` extension, pipeline hookup, tests

- Workflow `verifyLessonWorkflow(lessonId)`: step `seed` — insert 'checking' rows for every article block (ON CONFLICT DO NOTHING — idempotent re-entry); then per article block a step `verifyBlockStep(lessonId, i)`; then step `finalize(lessonId)`.
- `finalize`: compute faithfulness from the rows → update lessons.faithfulnessScore + lessons.verificationStatus = all-verified ? 'verified' : 'issues'; if score < ALERT_THRESHOLD → `console.warn('[founder-alert] faithfulness', {lessonId, score})` (the alert seam, greppable).
- **Regenerate-once:** inside verifyBlockStep, when badge would be 'unverified': call `regenerateBlock(db, lessonId, blockIndex)` — ONE `generate-lesson`-style call scoped to a single block (new purpose `regenerate-block`, generator tier; input = the lesson plan + dossier + the failing block + the unsupported claims; output = ONE article block schema) → validate (citations resolve + readability for the learner's band) + moderate → re-verify the new block's claims (extract+entail again) → if NOW verified: update lesson content block in place (CAS on status='ready' — read-modify-write the content jsonb with the block replaced; single UPDATE WHERE id AND status='ready') + status 'regenerated' (badge renders as verified w/ a subtle "updated" note); if STILL unverified → status 'unverified', original block kept. The unique index + 'regenerated' status make the once-rule structurally checkable: regenerateBlock refuses if the row's status is already 'regenerated'.
- Hook: stageGenerate's `deliver` fires `start(verifyLessonWorkflow, [lessonId]).catch(console.error)` after capture (fire-and-forget; lesson is usable immediately — that's the async promise).
- Tests: workflow-level via direct function calls (seed/verify/finalize sequence); regenerate path with a sequential mock (first entail unsupported → regenerate → second entail supported → content block replaced + status regenerated); once-rule (already-regenerated row refuses); finalize score + alert warn (spy console.warn).
- Full battery; commit.

### Task 4: Badges UI

**Files:** `src/app/api/lessons/[lessonId]/verification/route.ts` (new GET), lesson-view + article-section updates

- GET route: ladder → rows for the lesson → `[{blockId, status, claimsVerified, claimsTotal}]`.
- LessonView (ready state): fetch verification once on mount + poll every 5s WHILE any row is 'checking' (stop when none; max ~3 min then stop with whatever state); pass per-block status into ArticleSection.
- ArticleSection badge (testid `verify-badge`): 'checking' → subtle pulse dot + "checking sources"; 'verified' → sky check + "verified against sources"; 'regenerated' → same as verified + "updated"; 'unverified' → amber "couldn't verify — review the sources" treatment (visible, not scary). aria-labels; tooltips optional (skip).
- If GET returns zero rows (pre-Phase-6 lessons), render no badges (backward compatible).
- Full battery (e2e: badges appear for the fixture lesson — fake mode verifies instantly; assert at least one verify-badge with 'verified'); commit.

### Task 5: Phase-6 acceptance suite

**Files:** `src/test/phase-6-acceptance.test.ts`, e2e extension (the badge assertion from T4 if not already there), evals checks

- goal-1: full verify round-trip (seed→verify→finalize: rows per article block, badge statuses, faithfulnessScore set, verificationStatus 'verified').
- goal-2: url-guard (supported verdict w/ foreign url → unverified).
- goal-3: regenerate-once (content block replaced, 'regenerated' status, second regenerate refused).
- goal-4: alert seam (console.warn spied under threshold).
- goal-5: badges GET shape + backward-compat empty.
- evals: add `lessonVerified` check (run the verify sequence post-pipeline; assert faithfulnessScore ≥0.8 and verificationStatus 'verified' in fake mode).
- Full battery + push.

### Final: branch review + merge (controller).

## Done criteria
Acceptance suite green; delivered lessons get badges asynchronously without blocking delivery; unverified content is regenerated at most once then visibly flagged; faithfulness scored + alert seam live; migrations replay; no network/LLM in tests; full battery + fresh-main CI green.
