# Phase 4b: Streaming UX, Remaining Launch Blocks, Full Validators

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Conventions identical to Phases 1–4a (commit author flag, AI_FAKE_LLM gates everything, error.cause tests, testPool/afterAll, port 5433, plain testable functions + thin workflow steps). This plan is contract-style where patterns are established; bundled docs are authoritative for Workflow streaming (`node_modules/workflow/docs/foundations/streaming.mdx`, `api-reference/workflow-api/get-run.mdx`).

**Goal (= acceptance suite contract):** (1) Lesson generation streams visible progress — the learner sees the objective + block outline as soon as planning completes and stage updates live (no 2.5s blind polling); (2) lessons can contain FlashcardDeck, WorkedExample, and AnimatedDiagram blocks, rendered and interactive; (3) the full 4-launch validator suite runs: readability per age band with regenerate, glossary-alias scan, plus the security/robustness debt (correctIndex stripped from GET; stale-'generating' sweeper). Spec: §2 step 1/3, §3, §12-4b.

---

### Task 1: Workflow progress streaming + outline-early UX

**Files:** `src/server/lessons/pipeline.ts`, `src/workflows/generate-lesson.ts`, `src/app/api/tracks/[id]/lessons/route.ts` + retry route (persist runId), new `src/app/api/lessons/[lessonId]/stream/route.ts`, `src/app/(app)/tracks/[id]/lessons/[lessonId]/lesson-view.tsx`

- Read the bundled streaming docs FIRST. Steps emit progress events to the run's default stream: add a `'use step'` helper in the workflow file `emitProgress(stage: 'planned'|'researched'|'generating'|'ready'|'failed')` writing `{stage, at: Date.now()}` via `getWritable().getWriter()` (Date OK — steps run in Node, not the workflow sandbox; verify against serialization docs). The workflow emits after each stage step resolves (and 'failed' in the catch path before markFailed returns).
- Persist the workflow runId: `start()` returns `run.runId` — store in `lessons.zpdSnapshot.workflowRunId` (merge-update after start, in both create + retry routes; start already awaited/caught — keep that).
- `GET /api/lessons/[lessonId]/stream`: ownership ladder → read runId from zpdSnapshot → `getRun(runId).getReadable()` proxied as the Response body (content-type per docs; support `?startIndex=` passthrough if the API offers it). 404 when no runId; 409 when lesson already terminal (client then does one GET fetch instead).
- LessonView: when status==='generating', consume the stream (fetch + ReadableStream reader, newline/SSE framing per what getReadable emits — match docs) updating a `stage` state; ON 'ready'/'failed' events → fetch GET once → setData. Keep the 2.5s polling as FALLBACK when the stream errors/closes early (network proxies). Outline-early: while generating, if GET (initial load) returned a non-empty `spec` (objective/blockOutline persisted after stagePlan), render the objective + outline skeleton (testid `lesson-outline`) above the progress panel; the stream's 'planned' event triggers ONE refetch of GET to pick up the spec.
- Tests: integration — run the three stages directly and assert lessons.zpdSnapshot.workflowRunId set by route logic is read by the stream route guards (route guards unit-testable via exported helpers if needed); the workflow-level stream itself is exercised by the e2e (fake mode completes fast — the e2e asserts the lesson reaches ready via stream OR fallback without flake).
- Full verify + commit.

### Task 2: FlashcardDeck + WorkedExample blocks

**Files:** `src/server/lessons/blocks.ts`, fixtures, `src/components/lesson/flashcard-deck.tsx`, `src/components/lesson/worked-example.tsx`, lesson-view wiring, generator system-prompt block-type list, planner blockOutline enum

- Schemas (add to the discriminated union + blockOutline enum + generator prompt's allowed types):

```ts
export const flashcardDeckSchema = z.object({
  type: z.literal('flashcard_deck'),
  cards: z.array(z.object({ front: z.string().min(1).max(300), back: z.string().min(1).max(500) })).min(2).max(12),
});
export const workedExampleSchema = z.object({
  type: z.literal('worked_example'),
  problem: z.string().min(8).max(600),
  steps: z.array(z.object({ text: z.string().min(8).max(500) })).min(2).max(8),
  completionItem: quizItemSchema, // graded finish — keeps "≥1 graded interactive" semantics per block
});
```

- UI contracts: FlashcardDeck (testid `flashcard-deck`) — card flip on click (CSS transform, honors reduced-motion via the global rule), prev/next, "card i of n"; flips emit NO attempt events in 4b (FSRS arrives Phase 5 — comment this). WorkedExample (testid `worked-example`) — problem, steps revealed one at a time ("Show next step", testid `we-step-{i}`), then the completionItem as a graded quiz item (kind 'quiz', same attempts POST + aria-live pattern).
- Fixture: extend 'generate-lesson' with one flashcard_deck (3 cards: variable/assignment/name) + one worked_example (problem "store then update a count", 3 steps, completionItem id 'we1', correct option text 'count holds 7').
- Body-chars budget: flashcards/we text remains uncounted toward the 9000 proxy (articles only) — unchanged validator; the validator's "≥1 graded body block" now also satisfied by worked_example.completionItem — UPDATE validate.ts: graded-block check counts quiz blocks OR worked_example blocks.
- Tests: schema bounds; validate.ts graded-check update (worked_example alone passes); fixture coherence re-run; UI snapshot-free (the e2e covers interaction).
- Full verify + commit.

### Task 3: AnimatedDiagram block

**Files:** `src/server/lessons/blocks.ts`, fixtures, `src/components/lesson/animated-diagram.tsx`, wiring as in T2

- Constrained schema — the LLM emits ONLY parameterized primitives (never markup; spec §3 hard rule):

```ts
export const diagramShapeSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(['box', 'circle', 'arrow', 'label']),
  x: z.number().min(0).max(100), y: z.number().min(0).max(100),   // percentage coords
  w: z.number().min(1).max(100).optional(), h: z.number().min(1).max(100).optional(),
  toX: z.number().min(0).max(100).optional(), toY: z.number().min(0).max(100).optional(), // arrows
  text: z.string().max(60).optional(),
});
export const animatedDiagramSchema = z.object({
  type: z.literal('animated_diagram'),
  title: z.string().min(3).max(120),
  shapes: z.array(diagramShapeSchema).min(2).max(20),
  steps: z.array(z.object({
    highlightIds: z.array(z.string()).min(1).max(10),
    caption: z.string().min(8).max(300),
  })).min(2).max(8),
});
```

- Renderer (trusted code, testid `animated-diagram`): SVG viewBox 0 0 100 60 mapping percentage coords; sky/ink tokens; step-through buttons ("Next", testid `diagram-step`); current step's highlightIds get a sun-300 emphasis (CSS transition; reduced-motion → instant); caption below with aria-live; unknown highlightIds silently ignored at render BUT rejected by a validator: add to validate.ts — every step.highlightIds ⊆ shapes ids, arrows have toX/toY, labels/boxes have text where kind needs it (label requires text).
- Fixture: a 3-shape (two boxes + arrow), 2-step diagram about assignment flow; validator-coherent.
- Tests: schema; the new validate rules (bad highlightId fails; arrow missing toX fails); fixture coherence.
- Full verify + commit.

### Task 4: Validator suite completion + security/robustness debt

**Files:** `src/server/lessons/readability.ts` (new), `validate.ts`, `pipeline.ts` (deliver-time checks + regenerate threading), `src/app/api/lessons/[lessonId]/route.ts` (strip answers), quiz/win-check/worked-example client highlight via response only, sweeper in `src/server/lessons/pipeline.ts` + trigger in lesson GET + track page

- **Readability:** pure `fleschKincaidGrade(text)` (standard formula; syllable heuristic: vowel groups; tested against 3 known-grade sample texts with tolerance ±1.5). Age-band targets: 13_15 ≤ 9, 16_17 ≤ 11, 18_plus ≤ 14 (constants, commented as v1 calibration). Validator: compute over each article block's plain text (strip markdown symbols crudely — backticks/asterisks/links); out-of-band → error listing the worst sentences (split on [.!?], top 2 by grade). stageGenerate threads readability errors into the existing ONE corrective retry (merge with other validator errors); still failing after retry → fail lesson (consistent with current semantics). Learner ageBand: hydrate via track→learner join in stageGenerate (add to the track query).
- **Alias scan:** validate.ts gains `glossaryAvoidAliases: Array<{term, aliases[]}>` input; case-insensitive whole-word scan of article markdown + quiz/wincheck text for any avoided alias of a PROMOTED term → error naming term+alias (deterministic; spec §2 step 4). pipeline passes the track's glossary aliases.
- **Strip the answer key:** GET serializer deep-clones content removing `correctIndex` + `explanation` from all quiz-bearing structures (opener/quiz/worked_example.completionItem/winCheck); clients already grade via the attempts response — remove the now-dead correctIndex highlight logic from quiz-block/win-check/worked-example (highlight only the chosen option + correct/incorrect state from response). Update the GET TODO comment to done. e2e unaffected (it clicks by option text).
- **Sweeper:** `sweepStaleLessons(db, trackId)` — lessons stuck 'generating' with updatedAt older than 15 min → CAS to failed + refund (reuses failLesson; updatedAt is trigger-maintained). Called fire-and-forget from the track page server component and the lesson GET route. Test: integration with a backdated updatedAt (raw SQL update bypassing the trigger via `SET LOCAL`? simplest: UPDATE then manually set updated_at with a direct SQL `UPDATE lessons SET updated_at = now() - interval '20 minutes'` — triggers fire BEFORE UPDATE setting NEW.updated_at=now(); so direct column set is overridden! Workaround for the test: `ALTER TABLE ... DISABLE TRIGGER` in the test? NO — simplest: make the sweeper threshold injectable (`olderThanMs` param) and in the test pass a negative/zero threshold so freshly-created rows qualify. Production callers use the 15-min default.)
- Tests: readability unit (3 samples + band gates), alias scan unit, GET strip integration (fetch shape has no correctIndex anywhere — deep scan), sweeper integration (qualifying row fails+refunds; ready rows untouched; threshold respected).
- Full verify + commit.

### Task 5: Phase-4b acceptance suite (the phase-goal test)

**Files:** `src/test/phase-4b-acceptance.test.ts` (new), `e2e/onboarding.spec.ts` (extend), `evals/run-evals.ts` (extend checks), fixture finalization

Maps every Goal clause to an assertion:
1. **Streaming/outline:** integration — after stagePlan, GET-shape helper exposes spec with objective+outline (assert spec persisted before content); stream route guards (404 no-runId, 409 terminal). e2e: during generation either `lesson-outline` OR completed lesson appears (fake-mode races allowed — assert outline rendering by visiting a lesson whose row is manually staged: insert a 'generating' lesson WITH spec via testDb? e2e can't seed — instead the integration test covers outline data availability and the e2e covers end-state; acceptable, document).
2. **New blocks:** e2e — the fixture lesson now renders flashcard-deck (flip a card, navigate), worked-example (reveal steps, answer completion item correctly), animated-diagram (step through both steps, captions change), all before the win-check; complete the lesson as before.
3. **Validators:** unit/integration suite from T4 re-asserted via importing case lists (don't duplicate logic — the acceptance file asserts validateLessonContent rejects: alias violation, bad diagram ref, unreadable article (synthetic grade-16 text vs 13_15 band)) + GET strip assertion + sweeper assertion (re-export tests are fine — write thin acceptance wrappers that call the SAME helpers with phase-goal-named test titles).
4. **Evals:** add per-case checks `hasFlashcards`, `hasWorkedExample`, `hasAnimatedDiagram`, `noAnswerKeyInGet` (structural against fixture content) — evals still 10/10.
- Full verify battery + commit + push branch.

### Final: branch review + merge (controller-run, as every phase).

## Done criteria
All Goal clauses hold with the acceptance suite green; 141+ unit tests, e2e, evals, lint, tsc, build all green locally; fresh main-CI green post-merge; no test path reaches network/models; fixture coherence maintained (generate-lesson fixture exercises ALL 7 launch blocks).
