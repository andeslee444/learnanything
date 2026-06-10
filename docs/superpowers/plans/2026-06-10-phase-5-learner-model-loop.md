# Phase 5: Learner Model Loop (5a FSRS Reviews + 5b Distiller/Library)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. All established conventions apply (author flag, AI_FAKE_LLM, error.cause, testPool/afterAll, port 5433, plain functions + thin workflow steps, atomic jsonb merges, CAS terminal writes).

**Goal (= acceptance contract):** The learning loop becomes honest and closes. (1) Completing a lesson's win-check triggers the evidence-gated **distiller**: learning records written under the strict admission gate, glossary terms **promoted** (with evidence FK), node mastery derived from records (replacing the 4a cache hack's authority), and a **reference doc** created/updated in the Library. (2) Promoted glossary terms become **FSRS review cards**; a `/reviews` session serves due cards as objectively-graded MC items with the deterministic outcome→rating map, updating card state via ts-fsrs and logging every review. (3) The **Library** renders: glossary ("terms you own"), reference docs (print-CSS beautiful, PDF via print), and the learning-record timeline with supersession. Spec: §4, §8 retention, §12 phase 5; this is the spec's *first usable milestone*.

**Verified at plan time:** ts-fsrs is the canonical TS FSRS implementation (install `ts-fsrs`; verify API against its bundled types/README: `createEmptyCard`, `fsrs()`, `f.next(card, date, rating)` or `f.repeat` — implementer confirms). review_cards/review_log tables exist since Phase 1 (dual-FK XOR; ts-fsrs Card field mirror; review_log has the full FSRSHistory fields incl. last_elapsed_days/learning_steps).

**Carried architecture notes (from the 4b final review — binding):** promote `workflowRunId` to a real `lessons` column (migration; keep reading the snapshot as fallback during transition); widen attempts eventType usage with `'review'`; keep the NDJSON progress event payload a discriminated union if touched.

---

### Task 1: FSRS review engine (5a core)

**Files:** `src/lib/reviews.ts` (new), migration (workflow_run_id column), tests `src/lib/reviews.test.ts`

- `npm install ts-fsrs`. Read its README/types in node_modules — authoritative.
- Migration: `lessons` gains `workflowRunId: text('workflow_run_id')` (nullable); create+retry routes write it (keep zpdSnapshot merge too for one phase — stream route reads column ?? snapshot).
- `src/lib/reviews.ts` (all functions take `db` first — established DI):
  - `createCardForGlossaryTerm(db, {learnerId, glossaryTermId})` — `createEmptyCard()` mapped onto our review_cards columns (due=now, state 0); idempotent (skip if a card for that term+learner exists).
  - `getDueCards(db, learnerId, now=new Date(), limit=20)` — due ≤ now, joined to glossary term (term/definition/trackId), ordered by due.
  - `buildReviewItem(card, term, distractorDefinitions)` — MC item: question `What is "term"?`, options = [own definition, 3 distractors from OTHER glossary definitions (pad with fixed generic distractors when <3 exist)], deterministic shuffle seeded by card id (no Math.random — LCG on a string hash, like embeddings fake), correctIndex tracked server-side.
  - `gradeReview(db, {cardId, learnerId, correct, now})` — deterministic map: correct→Rating.Good, incorrect→Rating.Again (document: v1 two-point scale; Hard/Easy unused until self-paced grading exists); ts-fsrs `next()` → update review_cards fields + insert review_log row (ALL FSRSHistory fields) + attempt_event (eventType 'review', payload {cardId, glossaryTermId}). Ownership: card.learnerId must match.
- Tests (TDD where pure): deterministic shuffle (same card id → same order, different ids differ); rating map; card state progression (Again resets/lapses per ts-fsrs semantics — assert due moves out for Good, stays near for Again); due query (due vs future cards); idempotent card creation; review_log completeness (every column non-default where applicable); XOR/FK integrity ride on existing schema.
- Full battery + commit.

### Task 2: The distiller (5b core)

**Files:** `src/server/lessons/distiller.ts` (new), `src/workflows/distill-lesson.ts` (new), purposes/fixtures (`distill-records`), attempts-route trigger, pipeline mastery handover, tests

- New LlmPurpose `'distill-records'` (classifier tier — cheap, structured) + fixture. Output schema:
```ts
{ records: [{ recordType: 'demonstrated_understanding'|'corrected_misconception', title (≤120), body (≤400, 1-3 sentences), implications?: ≤300 }] (0-4),
  glossaryPromotions: [{ term ≤80, definition ≤300 }] (0-4) }
```
  Fixture: one demonstrated_understanding record ("Can use variables to store and update values") + one promotion ({term:'variable', definition:'A named container for a value.'}).
- `distillLesson(db, {lessonId, learnerId})` in distiller.ts:
  1. Load lesson (must be ready) + its win-check/quiz attempt events for THIS learner + track glossary + recent active records.
  2. **Admission gate is code + prompt**: prompt carries the rubric verbatim ("Coverage is not learning — only what the EVIDENCE shows; 1-3 sentences; not a journal"); evidence summary = per-item first-attempt correctness. Code-side: drop records whose title case-insensitively duplicates an existing active record title; drop promotions whose term already exists in track glossary (dedup per spec §4).
  3. Insert records via nextRecordSeq (FOR UPDATE convention), evidence jsonb = {lessonId, attemptEventIds, source:'distiller'}.
  4. Promotions: insert glossary_terms with promotionEvidenceRecordId = the FIRST inserted record id (if none inserted, create one 'demonstrated_understanding' umbrella record first — promotion REQUIRES evidence by FK); then `createCardForGlossaryTerm` for each (the FSRS bridge!).
  5. Mastery: if ≥1 demonstrated_understanding record inserted for this lesson's node → set node mastery 'demonstrated' (scoped trackId, like 4a). recordWinCheckResult KEEPS its immediate cache write for snappy UX; add comment that the distiller is the evidence authority.
  6. Idempotent: skip everything if a learning_record with evidence.lessonId == lessonId already exists (jsonb containment query).
- `distill-lesson.ts` workflow: one step calling distillLesson + progress events not needed (no UI yet) — keep minimal; started fire-and-forget (await/catch logging) from the attempts route when win-check passes (after recordWinCheckResult).
- **First-attempt-only win-check** (the TODO): the win-check tally now counts only each item's FIRST attempt_event (min created_at per itemId) — brute-force no longer reaches 'passed'. Re-answering still allowed (practice) but pass is decided by first attempts; if first attempts fail, the win-check-retry panel still appears — and a retry pass no longer flips mastery (document: the distiller weighs evidence; v1 keeps it simple: pass = first-attempt-correct ≥ ceil(0.85n)). UPDATE the e2e expectation if needed (e2e answers correctly first time — unaffected).
- Tests: full distill round-trip in fake mode (records inserted w/ correct seq + evidence; term promoted w/ FK; review card created; node mastery demonstrated; idempotent second run no-ops); dedup paths (existing term not re-promoted; duplicate title dropped); umbrella-record path (fixture variant via modelOverride mock returning promotions-only); first-attempt-only tally (wrong-then-right ≠ pass).
- Full battery + commit.

### Task 3: Reference docs (5b)

**Files:** distiller.ts extension, purpose/fixture `'create-reference-doc'`, tests

- New purpose `'create-reference-doc'` (generator tier) + fixture (a cheat_sheet for "Variables and types": title, docType 'cheat_sheet', content = {sections: [{heading, markdown}]} 1-6 sections, markdown ≤2000 each).
- Schema for output: `{ title ≤120, docType: enum(existing ref_doc_type values), sections: [{heading ≤80, markdown ≤2000}] (1-6) }`.
- Distiller step 7: when records were inserted, call it with the lesson objective + new records + glossary promotions → upsert reference_docs (one per (trackId, title): update content + linkedLessonIds append if title exists, else insert). linkedLessonIds gets the lessonId.
- Tests: doc created on distill; second lesson with same doc title updates not duplicates; linkedLessonIds appends.
- Full battery + commit.

### Task 4: Reviews UI (5a surface)

**Files:** `src/app/api/reviews/due/route.ts`, `src/app/api/reviews/[cardId]/route.ts`, `src/app/(app)/reviews/page.tsx` + client session component, header badge in `(app)/layout.tsx`

- GET /api/reviews/due: session→learner ladder → getDueCards → buildReviewItem each (distractors from the learner's OTHER terms across tracks; same-track first) → return items WITHOUT correctIndex (server holds it — stateless approach: include a signed/derivable check? Simplest robust: the POST recomputes the item server-side from the card id with the same seeded shuffle and grades answerIndex against the recomputed correctIndex — determinism makes this safe and stateless).
- POST /api/reviews/[cardId] {answerIndex}: ladder + ownership → recompute item → correct = answerIndex === recomputed.correctIndex → gradeReview → return {correct, correctOption: item.options[correctIndex], explanation: definition, nextDueInDays (derived from updated card)}.
- /reviews page: server component (due count, empty state "Nothing due — come back tomorrow" with sun styling) + client session: one card at a time (testids `review-card`, `review-option-{i}`), answer → feedback via aria-live (correct → "Nice — next review in ~N days"; wrong → show the right definition warmly) → next; finish panel (testid `reviews-done`) with count summary.
- Header: due-count badge (testid `reviews-badge`) linking /reviews — server layout queries count (cheap, indexed by learner+due).
- Full battery + commit.

### Task 5: Library UI (5b surface)

**Files:** `src/app/(app)/tracks/[id]/library/page.tsx` (+ print CSS in globals or module), reference-doc page `library/[docId]/page.tsx`, track-page link, record timeline component

- Library page (testid `library`): three sections — Glossary ("Terms you own": term + definition cards, testid `glossary-term`); Reference docs (cards linking to doc pages, testid `reference-doc-card`); "What you've learned" timeline (records newest-first: type chip, title, body; superseded records collapsed/struck with "understanding evolved" note, testid `record-item`).
- Doc page: renders sections (Streamdown for markdown), `@media print` styles (hide nav/buttons, serif headings, clean margins — print CSS is a feature per spec §11), "Download PDF" button = `window.print()` (testid `print-doc`).
- Track page gains a "Library" link (testid `library-link`).
- Full battery + commit.

### Task 6: Phase-5 acceptance suite + e2e + evals

**Files:** `src/test/phase-5-acceptance.test.ts`, `e2e/onboarding.spec.ts` extension, evals checks

- Acceptance (thin wrappers over real helpers, goal-named):
  - goal-1: distiller round-trip (records+promotion+card+mastery+reference doc, idempotent) — fake mode, full pipeline → distillLesson.
  - goal-1b: first-attempt-only pass semantics.
  - goal-2: due card → recomputed item determinism → gradeReview Good path moves due out; Again path logs lapse; review_log completeness; attempt_event 'review' written.
  - goal-3: GET shapes — due route strips correctIndex; library data assembly (terms+docs+records with supersession flags).
- e2e: after lesson-complete → trigger is automatic (distill workflow, fake-fast) → navigate to Library (`library-link`): glossary term 'variable' present, reference doc card present, record timeline non-empty → header `reviews-badge` shows ≥1 → /reviews: answer the due card CORRECTLY (the correct option is the term's definition text — fixture-known: 'A named container for a value.') → `reviews-done`.
- evals: add checks `distillerProducesRecords`, `glossaryPromoted`, `referenceDocCreated` (run distillLesson after the pipeline in each case; fake mode).
- Full battery + commit + push branch.

### Final: branch review + merge (controller).

## Done criteria
The acceptance suite + extended e2e prove the Goal end-to-end in fake mode; first-attempt-only grading closes the brute-force TODO; every review is logged with full FSRSHistory fields from day one (spec §4 promise); no network/LLM in tests; full battery + fresh-main CI green; spec's "first usable milestone" reached — a learner can onboard → learn → be distilled → review → own a Library.
