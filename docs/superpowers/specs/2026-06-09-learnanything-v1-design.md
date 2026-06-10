# LearnAnything v1 — Design Spec

*2026-06-09. Status: awaiting founder review. Derived from [build-considerations research](../../research/2026-06-09-build-considerations.md) + founder decisions.*

## Decision log

Founder-confirmed (2026-06-09):
1. **Launch 13+** behind a neutral age screen; Kids mode (verifiable parental consent) is a later phase.
2. **Curated verticals at launch**, not "anything" — default set below.
3. **Citations promise = async**: "every lesson cites vetted sources; verification runs continuously; badges + pushed corrections." Never blocks first render.
4. **Lessons are publicly shareable** (sanitized canonical versions; acquisition loop).
5. **v1 = code-rendered animation only** (no diffusion video); voice = TTS narration; conversational voice tutor deferred to v1.5.

Defaults chosen by Claude — veto in review:
- **Verticals (4, staged):** launch with **programming + history** (one procedure-heavy, one knowledge-heavy — halves the up-front allowlist curation and golden-set authoring, both founder labor); math + science fast-follow once the curation workflow is proven.
- **Buyer/persona:** the learner, self-pay (teen/adult). Parent dashboard deferred to Kids mode.
- **English-only v1.** i18n is a planned phase, not an afterthought (schema keeps language fields).
- **Responsive web + PWA**, no native app in v1.
- **Auth: Better-Auth** on our Postgres (first-party child-data posture, family-account extensibility, no per-MAU fees). Swappable for Clerk if build speed wins.
- **Payments: Stripe** (Checkout + Billing) with a credits ledger under a $15/mo subscription; free tier ~3 lessons/mo. Merchant-of-record revisited when international VAT volume matters.
- **North-star metric: evidenced mastery / delayed retention** (7-day review performance), not DAU.
- **Public data promises:** no training on learner data, no ads ever, export anytime (JSON + Markdown), one-click delete (with stated 30-day backup-retention caveat).
- **Notion/Drive: not in v1.** Direct upload + PDF export of reference docs covers the durable-artifact story at launch.

## 1. Product scope

### Personas
**The learner** (13+, self-directed): types what they want to learn, answers a short mission interview, receives one tightly-scoped lesson at a time, reviews on an FSRS schedule, keeps a Library of durable artifacts (glossary, reference docs).

### Core flows
1. **Onboarding / mission interview** — hero input ("What do you want to learn?") → 3–5 adaptive questions max (~2 min): why (one concreteness follow-up max; "just curious" is valid), success criteria, constraints, prior knowledge, optional out-of-scope → editable Mission card → **track initialization** (skill-graph decomposition, §2) + calibration micro-quiz (2–4 items; results seed `prior_knowledge` learning records, initial node mastery, and rating priors) → **lesson #1 starts generating immediately**. "Background resource curation" = populating the track's annotated `resources` list and `resource_gaps` rows; it is separate from (and slower than) per-lesson dossier research.
2. **Lesson loop** — ZPD planner **proposes** the next skill-graph frontier node, with learner override: a "learn something specific" input (the skill says ZPD inference is the fallback, not the rule) and an "I already know this" control that writes a `prior_knowledge` record (claimed depth noted, optional one-item verification) → research (dossier cache) → generated lesson streams in block-by-block → learner completes win-check → distiller job proposes learning records → FSRS cards created. **Latency policy:** outline ≤ ~5s always (the planner needs only track state, not the dossier); first interactive block ≤ ~20s on a dossier-cache hit; on a cold miss the visible research feed + opener-retrieval blocks carry the wait and the first factual block lands typically in 1–3 min (never parametric-only to go faster).
3. **Review loop** — daily due-card sessions (flashcards/micro-quiz drawn from the learner's own records + glossary); every new lesson opens with 2–3 retrieval items from prior lessons (spacing + interleaving).
4. **Library** — per-track glossary ("terms you own"), reference docs (print-CSS beautiful, PDF export), learning-record timeline ("what you've learned", supersession shown as "your understanding evolved").
4b. **Wisdom surface** — a "practice in the real world" panel on the track dashboard fed by `kind='wisdom'` resources (named major communities, local-class suggestions); the tutor panel answers wisdom-shaped questions briefly then delegates to a vetted community; `tracks.community_opt_out` permanently suppresses recommendations once set.
5. **Share** — learner publishes a sanitized canonical version of a lesson to a public page (see §7).

### Out of scope (v1)
Kids mode / under-13 · conversational voice tutor · LLM-written game code (only parameterized templates, and even those are v1.5) · Remotion video · Notion/Drive integrations · school/LTI channel · marketplace/remix · certificates/third-party mastery claims · native apps · non-English.

## 2. Architecture

Single Next.js (App Router) app on Vercel. TypeScript everywhere.

| Concern | Choice |
|---|---|
| Orchestration | Vercel AI SDK 6 (agents, `streamObject`, structured outputs) |
| Durable generation | Vercel Workflows (`'use workflow'`) — multi-minute runs, retryable steps, reconnectable progress streams |
| Models | Claude (Opus tier for planner/generator, Sonnet tier for sub-tasks, Haiku tier for classification/vetting) via Vercel AI Gateway with a Sonnet-tier fallback route. Verify current model IDs/prices at build time |
| DB | Postgres (Neon) + pgvector — learner model, dossier cache, embeddings. All schema vendor-neutral |
| Search | Exa behind an internal `ResearchProvider` interface; Firecrawl for known-canonical URL scraping |
| Observability | LangSmith (traces AI SDK natively) + per-stage cost/latency budgets with alerts |
| Auth | Better-Auth (Postgres-backed) |
| Email | Resend (`reviews due`, weekly mission report, `lesson ready`) |
| Payments | Stripe + internal credits ledger (holds/refunds on failed generations) |
| Analytics | PostHog Cloud EU under a DPA; **no learner content or PII in events** (pseudonymous IDs only); learning-outcome events first-class |

**Vendor-neutrality rule:** LessonSpec schema, prompts, learner-model tables, FSRS core, and the ResearchProvider interface must not import Vercel- or Anthropic-specific types. Renderer and workflow glue may.

### Track initialization (once per track, at Mission confirmation)
An Opus-tier structured-output call decomposes the mission's success criteria into `skill_nodes` + `skill_node_edges` (validated: acyclic, 10–40 nodes, depth ≤ 5, `out_of_scope` topics excluded). Calibration-quiz results seed initial node mastery, `prior_knowledge` learning records, and `concept_ability` priors. The graph is revisable: a `mission_shift` learning record triggers a proposed graph revision (approve/edit card, like mission edits) — never shown to the learner as a rigid course.

### Generation pipeline (one Vercel Workflow run per lesson, steps 1–6)
1. **Plan** — hydrate track state (mission, active records, glossary, prefs; token-budgeted — see §4 context governance) → ZPD planner emits the LessonSpec skeleton (Zod, Claude structured outputs). Frontier ranking = mission relevance with a boost for nodes adjacent to `corrected_misconception` records; item difficulty targets **~70–85% recent first-try accuracy** ("challenged just enough"). **The outline + opener-retrieval blocks stream to the client immediately** — they depend only on track state, not the dossier.
2. **Research (runs concurrently with the client rendering step-1 output)** — dossier-cache lookup (pgvector ≥0.92 similarity = hit → skip to step 3). Miss → Exa search with vertical allowlist (`includeDomains`); if <3 vetted sources, widen to open web with the curated blocklist (§5) and re-vet; if *still* <3 vetted sources, queue the lesson + notify (§9) — never proceed parametric-only. Retrieved pages pass through **quarantined extraction**: a no-tools model converts raw pages into a constrained facts/claims schema; the generator never sees raw HTML → Haiku-tier source vetting → dossier persisted (sources, claims, citations, glossary seeds, misconception list, TTL per subject class).
3. **Generate** — body blocks stream via `streamObject` against the block registry as dossier claims become available; client renders progressively (visible research feed on cold misses, skeleton shimmer).
4. **Validate (sync, cheap)** — single-objective lint; estimated learner completion time within 5–15 min (per-format caps, checked against `estimated_minutes`); mandatory auto-gradeable win-check; **≥1 graded interactive block on the current objective within the lesson body** (opener retrieval and win-check don't count — no passive bodies); every factual block carries ≥1 citation resolving to a dossier source; deterministic scan for `avoid_aliases` of promoted glossary terms (rewrite flagged sentences — glossary is canonical language, not prompt vibes); readability score within the learner's bands (§6; regenerate flagged sentences); moderation pass on the assembled lesson.
5. **Deliver** — lesson status `ready`; learner starts immediately; credit hold captured.
6. **Verify (async)** — claim extraction → entailment check (LLM-judge) of each claim against its cited source span → per-block badges: `verified` / `checking` / `unverified` (unsupported claims auto-regenerate once, then flagged and visually quarantined) → per-lesson faithfulness score logged; corrections pushed to already-delivered lessons and their shared copies (§7).

**Distill (separate event-triggered job, not a workflow step)** — fires on win-check completion (which may be days later or never): the distiller proposes learning records under the strict admission gate (evidence only; coverage ≠ learning; dedup vs glossary); FSRS cards created for new glossary/concepts; **creates-or-updates a reference doc** when the lesson introduced reference-worthy material (cheat sheet, syntax card, worked algorithm — "lessons will rarely be revisited; reference documents will be"). LessonSpec carries a `related_reference_docs` field rendered as links.

Failed runs refund the credit hold and surface a retry.

## 3. Lesson system

**LessonSpec** (Zod): `{ objective (exactly one), format, estimated_minutes, zpd_snapshot, opener_retrieval[0-3], blocks[], win_check, citations[], glossary_candidates[], related_reference_docs[] }`. Flat block list with IDs (structured-output constraint: no recursion). `opener_retrieval` may be empty only for lesson #1, which seeds openers from calibration-quiz items instead. Citations are plain schema fields (structured outputs are incompatible with the provider citations feature — carry sources from the research step).

**Renderer:** Streamdown for streamed article flow; custom fenced directives (```` ```quiz ````, ```` ```flashcards ````, ```` ```timeline ````, …) with Zod-validated JSON bodies mapped to a whitelisted React block registry. **Never compile LLM-emitted MDX.** No LLM HTML touches the DOM in v1 (the sandboxed-iframe ArtifactBlock is a post-v1 layer).

**v1 block registry (11, shipped in two increments):** launch set (7) = ArticleSection (citations required), Quiz (MC + short-answer, graded before explanation reveals), FlashcardDeck, WorkedExample (with fading stages), **AnimatedDiagram** (constrained step/keyframe schema over parameterized drawing primitives — this block is what "code-rendered animated lessons" means in v1), GlossaryCallout, WinCheck; fast-follow increment (4) = Timeline, Diagram (static), FillInBlank, CodeBlock (display-only). **Diagram blocks are parameterized primitives rendered by trusted code — the LLM never emits raw SVG/HTML markup** (same rule as MDX). All blocks: Motion animations behind a `MotionConfig reducedMotion="user"` global + in-app toggle; DOM/ARIA-based, keyboard navigable; every interactive block emits `attempt_events`.

**Pedagogy rules encoded as validators + a stable cached system-prompt prefix:** retrieval-first interactions; interleaved practice sets; guidance-fading stage chosen from the learner's expertise state; mastery gate = **win-check score ≥85%** (auto-graded rubric) to mark the node's objective demonstrated — below it, re-teach in a different representation; tutor panel never gives a full solution on first ask (hint ladder, ≤3 sentences); tutor answers wisdom-shaped questions briefly then delegates to a vetted community (§1 flow 4b); a session-length nudge after ~45 min ("good stopping point after this win-check" — SB 243 hygiene that also serves spaced practice); format chosen by subject demands + prior knowledge + Mayer principles + learner choice — **no learning-styles inference, ever** (engagement-preference data may inform *offered choices*, never "how you learn" claims).

**TTS narration:** one "Listen" action per lesson — script derived from blocks, OpenAI mini-TTS tier (~$0.015/min), audio cached per lesson version; transcript doubles as captions.

## 4. Learner model (Postgres)

`users` (Better-Auth) → `learners` (1:1 in v1; `age_band` enum `13_15|16_17|18_plus` captured at the age screen; `provenance` enum `consumer|school` and parent-linkage columns reserved now for Kids mode/families) → `tracks`.

**Bands, defined once:** `age_band` (above) drives moderation policy, readability targets, and the eval matrix. A separate per-track **expertise band** (`novice|developing|competent`, derived from the guidance-fading state) is the "level band" in the dossier cache key. The two are never conflated.

Track-scoped: `missions` (UNIQUE per track; success_criteria jsonb, constraints, out_of_scope) + `mission_revisions` (proposed-then-approved, linked learning record) · `skill_nodes` + `skill_node_edges` (DAG; mastery cached, derived from records) · `learning_records` (per-track seq; type enum `demonstrated_understanding|prior_knowledge|corrected_misconception|mission_shift`; body 1–3 sentences; evidence jsonb; status `active|superseded` + self-FK) · `glossary_terms` (promotion-gated by evidence; avoid_aliases; learner-authored definitions encouraged) · `resources` (annotated, kind `knowledge|wisdom`, origin, pruned status) + `resource_gaps` · `reference_docs` (typed; print-CSS; PDF export) · `lessons` (spec jsonb, content, citations, status, verification_status, faithfulness_score, zpd_snapshot, model_version, shared_lesson_id nullable FK) · `shared_lessons` (FK to source lesson; block-level sanitized content; unique slug; moderation_status; verification badges inherited; retrieval dates).

Learner-scoped: `attempt_events` (append-only feedback stream) · `review_cards` (ts-fsrs Card 1:1: due, stability, difficulty, reps, lapses, state…; **dual-FK source: `glossary_term_id` or `learning_record_id`** — the review loop draws cards from the learner's own artifacts) + `review_log` (every review logged from day one) · `concept_ability` + `item_difficulty` (**schema reserved, not active in v1**: the Elo/Birdbrain layer activates in v1.x once there is attempt data to calibrate LLM-emitted difficulty priors against; v1 mastery/ZPD runs on windowed per-node first-try accuracy) · soft profile = `learners.profile` jsonb.

Billing: `credit_ledger` (append-only; type `purchase|grant|hold|capture|refund`; Stripe refs). One standard lesson = 1 credit (hold at workflow start, capture on Deliver, refund on terminal failure); TTS narration included; free tier = 3 grants/month, no rollover; subscription = monthly grant.

Rules: **retention (FSRS) and mastery (rubric+Elo) are separate fields with separate update paths.** Outcome→FSRS-rating mapping is deterministic (never LLM-chosen). Records are machine-proposed post-session (async distiller), strict admission gate, supersession preserves history.

**Context governance:** generation calls hydrate at most ~8k tokens of track state — mission + active records (most recent/most relevant via pgvector over records when count > ~50) + glossary terms + prefs. Tracks older than 6 months get record summarization into a rolled-up prior-knowledge record (originals kept, marked archived).

**Global:** `topic_dossiers` (cache key: vertical+topic+level band; embedding; sources/claims jsonb; TTL by subject class: programming 7–14d, science 90d, math/history 6–12mo; model_version for re-verification on model swaps). Dossiers are shared across learners; **lessons are always personalized** (mission framing, prior-knowledge bridges, examples) — skeleton-sharing is explicitly rejected to protect the core promise.

## 5. Research & trust layer

Tiered per-vertical domain allowlists (versioned rows; Tier 1 primary/official, Tier 2 recognized experts, Tier 3 open web) plus a global **blocklist** (content farms, SEO spam, scraped-answer mills) — both founder-curated, versioned DB rows. **The founder owns allowlist/blocklist curation at launch** (~quarterly review; `resource_gaps` rows trigger targeted searches). Layer 2: Exa category filters. Layer 3: Haiku-tier LLM-judge vetting with trust rationale stored. Wisdom/community recommendations in v1: named major communities + "find a local class" suggestions only (no long-tail forums; link-rot re-check on surface).

## 6. Safety, privacy, accessibility (v1 gates)

- Neutral age screen (no nudging); 13–17 attestation flow; block + don't store under-13 signups.
- Moderation at 3 points (request, retrieved content, assembled lesson): fast moderation API first pass + custom-policy LLM judge (age-banded topics; dual-use educational topics policy: lawful-but-sensitive topics get sourcing-tier escalation + disclaimers, weapons/CSAM/self-harm instructions refused); human review queue + audit log; regulated topics (medical/legal/financial) render with professional-advice disclaimers + Tier-1-only sourcing.
- Prompt injection: quarantined extraction (§2), spotlighting delimiters, generator has no fetch tools and no learner-record write access triggered by retrieved content.
- Crisis interrupt: self-harm detector → 988/crisis resources; persistent "AI tutor" disclosure.
- Uploads: PDF/docx/txt/md drag-drop → **text-only extraction** to Markdown; embedded images are never extracted, stored, or rendered in v1, and the raw file is **discarded immediately after normalization** — this removes image-hosting exposure (CSAM-scanning vendor access is a v1.x prerequisite for any image ingestion). Extracted text is treated as untrusted (same quarantine path).
- Human review queue = the founder, stated plainly. Policy: target flag rate <2% of generations; flagged lessons fail **safe-and-refunded** (credit refunded, "try a different angle" suggestion) rather than holding the learner waiting; auto-resolve to refunded after 12h unreviewed; only severity-high flags page immediately.
- Retention by artifact class: normalized upload Markdown lives as track context while the track is active; tutor-chat transcripts auto-expire at 90 days; TTS caption transcripts and Library artifacts (`reference_docs`, glossary) persist with the lesson/track — durability and captions are promises, not retention liabilities.
- WCAG 2.2 AA: reduced-motion global, captions/transcripts, keyboard-navigable blocks, axe-core in CI + render-time scan on generated lessons; sentence-level readability regeneration per age band.
- Privacy: data promises in §Decision log enforced in schema (no third-party analytics events containing learner content; export + cascading delete endpoints; documented backup-retention policy).

## 7. Public lesson pages

"Share" creates `shared_lessons`: a **block-level sanitized canonical version** — every block is scanned for learner-derived content (mission framing, prior-knowledge bridges, personalized examples, learner identity, learning-record references) and regenerated from the dossier or dropped, not just the intro. Regenerated content runs through the same §2 validate + async-verify stages; **public pages display verification badges + retrieval dates** (this is the acquisition surface where the citations promise is most visible); pushed corrections propagate to shared copies, and a faithfulness regression auto-unpublishes pending review. Public route `/learn/{vertical}/{topic-slug}-{shortid}` (slug uniqueness via short id; one shared page per source lesson) with a "Make this lesson yours" CTA (starts a track → onboarding). Shared pages carry DMCA contact + report button; designated DMCA agent registered before the first public page; takedown process: auto-unpublish on valid notice, counter-notice handling per DMCA, repeat-infringer account policy in ToS. CC-BY sources attributed in the required format; quote lengths capped by the generator. Unshared lessons are private by default. (Programmatic SEO from dossiers alone: post-v1.)

> **Feasibility note (founder call):** the scope review recommends launching private-only and enabling sharing as the v1.1 fast-follow — it's the single largest compliance surface (sanitizer, re-pass moderation, DMCA ops, report triage) and its acquisition value is near zero before a content corpus exists. Sharing is sequenced as the final build phase either way; the decision is whether launch waits for it.

## 8. Notifications & retention

Resend email v1: due-review digest (daily max 1), weekly mission report (evidenced progress vs success criteria), "your lesson is ready" for background completions, implementation-intention prompt at session end ("when's your next session?" → scheduled reminder). No streak loss-aversion mechanics; no leaderboards. Web push via PWA: post-v1.

## 9. Error handling

- Generation step failure → workflow retry (per-step policy) → terminal failure refunds credit hold + friendly retry UI.
- Exa outage, or <3 vetted sources even after the open-web widening in §2 step 2 → serve from dossier cache if fresh; otherwise queue lesson + notify — **never silently fall back to parametric-only generation**.
- Model outage → AI Gateway fallback route (Sonnet tier); `model_version` stamped on outputs. After model swaps, re-verification is **lazy and bounded**: dossiers re-verify on next cache read when `model_version` is stale; corrections push only to lessons viewed in the last 30 days and to live shared pages — never an unbounded batch over the whole corpus.
- Verification finding unsupported claims post-delivery → block quarantined visually + correction pushed; repeated faithfulness regressions page the founder (alert threshold).
- Moderation flag → lesson held + human queue; learner sees neutral "needs a quick review" state.

## 10. Testing & evals

- Vitest (unit: validators, FSRS mapping, Elo updates, sanitizer) · Playwright (flows: onboarding→lesson #1, review session, share) · axe-core a11y CI.
- **Eval harness (LangSmith datasets):** golden set = 18 cases at launch (2 verticals × 3 age bands × 3 formats), growing to 36 as math + science land; run in CI on prompt/model changes; LLM-judge rubrics: single-objective, ZPD fit, citation coverage, readability band, guardrail compliance (no full solutions); faithfulness score distribution tracked; quarterly human calibration of judges.
- Metrics hierarchy: (1) 7-day review retention + evidenced mastery, (2) mission progress, (3) activation (time-to-first-win-check), (4) engagement. A/B decisions require (1) not to regress.

## 11. Design language ("clear blue skies")

Light-first. Sky-gradient hero moments, generous whitespace, soft cloud motifs; warm sun accent for wins/mastery. Two-weight type, large readable body. Motion: lesson blocks float in unhurriedly; everything honors reduced-motion. The Library prints beautifully (print CSS is a feature, not an afterthought). Dark mode: post-v1.

## 12. Build roadmap (one plan→execute cycle per phase, not one plan)

This is a roadmap of plan cycles, not a single implementation plan. Safety baselines, metering, and evals are threaded through the phases that need them — not bolted on at the end. **First usable milestone = end of Phase 5** (a learner can onboard, take lessons, review, and build a Library); everything after is launch hardening.

1. **Foundation** — repo, Next.js, Better-Auth, full Postgres schema + migrations (including the reserved tables and a minimal internal `credit_ledger` with hardcoded free-tier grants — no Stripe yet), design tokens.
2. **Onboarding** — neutral age screen (before any external user touches the flow), mission interview, Mission card, track initialization (skill-graph decomposition + calibration quiz; answers stored raw, distilled in Phase 5), track dashboard. Done-state: mission + graph persisted, "first lesson coming up" stub (the pipeline arrives in Phase 4).
3. **Research layer** — ResearchProvider interface, allowlists/blocklist (programming + history curated up front — budget founder days for it), quarantined extraction, dossier cache, baseline moderation-API pass on requests + retrieved content.
4. **Lesson pipeline** — 4a: Workflow + LessonSpec + plan/research/generate happy path with 4 blocks (ArticleSection, Quiz, WinCheck, GlossaryCallout), credit hold/capture wired, baseline moderation on assembled lessons, **eval-harness skeleton (LangSmith dataset, CI hook, ~10 seed cases — grows with every later phase)**. 4b: remaining launch blocks (FlashcardDeck, WorkedExample, AnimatedDiagram), full validator suite, progressive-streaming UX.
5. **Learner model loop** — 5a: attempt events + FSRS review sessions. 5b: distiller job, glossary promotion, reference-doc creation, Library + PDF export. ← *first usable milestone*
6. **Async verification** — claim extraction, entailment checks, badges, bounded corrections push.
7. **Safety hardening** — custom-policy LLM judge with age-banded topics, crisis interrupt, session nudge, review-queue tooling, a11y CI (axe-core), readability regeneration loop.
8. **Modality + ingestion** — TTS narration; text-only uploads; Resend notifications (review digest, mission report, lesson-ready).
9. **Monetization + launch checklist** — Stripe Checkout/Billing on the existing ledger; privacy policy + ToS published (gates the first externally visible surface); data export/delete endpoints; eval set grown to the full 36-case matrix.
10. **Public sharing** (founder call per §7 — v1 finale or v1.1 fast-follow) — sanitizer, share flow, public routes with badges, DMCA agent (registration kicked off early — external lead time) + takedown process, report triage.
