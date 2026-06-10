# LearnAnything — Build Considerations

*Research synthesis, 2026-06-09. Produced by a 10-agent research workflow (9 domain researchers + adversarial completeness critic). Status: pre-design brainstorm input — not an approved spec.*

> ⚠️ **Verification caveat:** model IDs/prices and several fast-moving claims below (Sora API sunset, Exa March-2026 repricing, Thesys pricing, COPPA 2.0 Senate passage, Vercel Workflows billing) came from single-source web research. Re-verify against primary sources before they drive code, economics, or legal posture.

---

## 1. The vision, corrected by evidence

Three load-bearing corrections to the original pitch before anything gets built:

### 1.1 "Format best suited to the way the student best learns" is the debunked VARK myth
Matching lesson modality to a self-reported "learning style" has no evidence base (Pashler et al. 2008 through a 2024 meta-analysis; widely labeled a neuromyth). **Never ship a learning-styles quiz; never market "we detect how you learn best."** What should drive format choice instead, in order:
1. **Subject demands** — spatial/dynamic content → animation/diagrams; procedures → worked examples + practice; vocabulary/facts → flashcards + spaced repetition; skills → interactive feedback loops. For every student.
2. **Prior knowledge** (expertise-reversal effect — novices need worked examples, experts need problems; the same scaffold helps one and hurts the other)
3. **Mayer's multimedia principles** (universal: words+pictures beat words alone; cut decorative animation; segment into learner-paced chunks; narration+animation over text+animation)
4. **Accessibility needs** (audio for low vision, captions for deaf, reduced motion)
5. **Learner choice** — as an *autonomy/motivation* lever (self-determination theory), which is the legitimate home of "pick your format"

Per-student format-preference data is fine as engagement signal — but draw this line explicitly in design docs or the marketing copy will drift back to VARK.

### 1.2 "Any age" is legally undeliverable at MVP
The amended COPPA Rule is fully in force (compliance deadline April 22, 2026; FTC's stated 2026 enforcement priority). Under-13 requires verifiable parental consent infrastructure, retention limits, a written security program; audio recordings of children are now personal information. **Launch 13+ behind a neutral age screen; ship "Kids mode" later** with VPC via a Safe Harbor vendor (PRIVO, kidSAFE) and Khanmigo-style guardrails (no open chat, parent dashboard, moderation alerts, session limits). Anthropic permits API products serving minors *with* documented safeguards + audit readiness (the consumer-Claude 18+ rule doesn't apply to API products). California SB 243 (companion chatbots, private right of action) likely touches a friendly voice tutor — AI disclosure, break reminders, crisis-referral interrupts.

### 1.3 "Beautiful animated lessons" should mean code-rendered animation, not generative video
Diffusion video is 10–50x the cost of everything else (~$0.90–7.50 per 30s clip) and unstable as a dependency (Sora 2 API reportedly sunsets Sept 2026). Remotion (LLM-written React video, rendered on Remotion Lambda, pennies/minute), Motion/Framer-Motion lesson blocks, and SVG/canvas animation deliver the brand at ~1% of the cost — and can render accurate text, equations, and citations, which diffusion models cannot.

Also corrected: **OpenUI (wandb/openui) is the wrong tool** — it's a self-hosted dev-prototyping app ("like v0 but open source"), not a runtime library for generating lesson UI. Steal its idea (LLM-written HTML in an iframe) as a sandboxed escape hatch; don't take the dependency.

---

## 2. What the teach skill becomes as a product

The skill is a pedagogical state machine in six filesystem artifacts. Every one maps to a DB entity; the **lesson is disposable — the learning state is the product**.

| Teach-skill artifact | Product entity | Notes |
|---|---|---|
| workspace (cwd) | `tracks` (user has many) | "one mission per workspace" → UNIQUE constraint |
| MISSION.md | `missions` (1:1 with track) + `mission_revisions` | why, success criteria, constraints, out-of-scope; system proposes edits, user approves |
| learning-records/*.md | `learning_records` (ADR-style, append-only) | typed: demonstrated_understanding / prior_knowledge / corrected_misconception / mission_shift; `status` active/superseded + self-FK; **evidence-gated** (coverage ≠ learning) |
| RESOURCES.md | `resources` + `resource_gaps` | kind knowledge/wisdom, mandatory annotation, trust rationale, pruning |
| GLOSSARY.md | `glossary_terms` | **promotion-gated**: a term enters only after evidenced use; great mechanic: student writes the definition |
| reference/*.html | `reference_docs` | the durable "Library" — print-beautiful, PDF-exportable; the artifact worth syncing to Notion later |
| lessons/*.html | `lessons` (LessonSpec JSON + content + citations) | rendered in-app, NOT raw LLM HTML to the DOM |
| NOTES.md | `teaching_preferences` | engagement signals, format prefs (see §1.1 caveat) |

**The generation loop** (one cycle, repeated): mission grounds planning → resources ground content → lesson produces evidence (attempt_events) → evidence distills into learning records → records recalculate the zone of proximal development → next LessonSpec.

**ZPD as an algorithm, not a vibe:** decompose mission success criteria into a skill graph (`skill_nodes` DAG); mastery set ONLY by active evidence-backed records; frontier = unmastered nodes with mastered prerequisites; rank by mission relevance, boost nodes adjacent to corrected misconceptions; calibrate difficulty to ~70–85% recent first-try accuracy; emit schema-validated LessonSpec.

**Onboarding (mission interview, rule #1) vs activation:** cap the interview at 3–5 questions / ~2 minutes; accept "just curious" as a mission archetype; LLM concreteness check with ONE follow-up max; editable Mission card; calibration micro-quiz + Exa resource-gathering run in background; **lesson #1 generates immediately** — don't block on full curation.

**Hard validators on every lesson** (not prompt vibes): single objective; 5–15 min budget (per-format caps); mandatory auto-gradeable win-check ("you can now do X"); citations resolving to vetted Resource rows; ≥1 interactive element in every format (no passive-only lessons, ever).

---

## 3. Evidence-based generator rules (pedagogy research)

1. **Retrieval practice is the default interaction** (g≈0.50): every lesson embeds + ends with recall questions answered *before* the explanation shows. Retrieval performance — not self-report — is the evidence written to learning records.
2. **Spaced repetition via FSRS** (`ts-fsrs`, MIT, FSRS-6): review items generated from each lesson's glossary/records, ~90% target retention. Log every review from day one (per-student parameter optimization needs the history).
3. **Interleave practice sets** (d=0.83 preregistered RCT): mix current-lesson items with prior-lesson retrieval; tell the student it's *supposed* to feel harder.
4. **Guidance fading state machine** per concept: NOVICE full worked examples → DEVELOPING completion problems → COMPETENT independent + hints (expertise-reversal-aware).
5. **Mastery gating** ~80–90% on retrieval checks; failure → re-teach in a *different representation*, not repetition. Don't market Bloom's 2-sigma (realistic: ~0.5σ).
6. **Tutor guardrails are the product** (Harvard PS2 Pal RCT, World Bank Nigeria +0.31 SD, Bastani PNAS): short responses, one step at a time, never the full solution on first ask, force attempts. Unguardrailed answer-giving AI made students *worse* (−17% when removed).
7. **Motivation = self-determination theory**: mission = autonomy, evidenced mastery progress = competence, communities/tutor warmth = relatedness. Prefer weekly mission check-ins + implementation intentions ("when will you do your next lesson?") over loss-aversion streaks; leaderboards demotivate the bottom half. **Instrument delayed retention, not just DAU**, or the product drifts into an engagement farm.

---

## 4. Recommended architecture (Approach A) and alternatives

### Approach A — TypeScript monolith on Vercel (RECOMMENDED)
Single Next.js app. **Vercel AI SDK 6** (agents, structured outputs, streaming) instead of LangChain *in-app*; **Vercel Workflows** (`'use workflow'`) for durable 1–5 min lesson generation with reconnectable progress streams; **Claude structured outputs** (Zod LessonSpec) — note: reportedly incompatible with the API citations feature, so citations are ordinary schema fields populated by the research step; **Neon/Supabase Postgres + pgvector** for the entire learner model + embeddings; **LangSmith for observability** (natively traces AI SDK apps — keeps the LangChain ecosystem where it's strongest for this stack). Claude Files API for uploads (LlamaParse only for hard PDFs).
- *Pros:* minimum service count, one language, first-class on the deploy target, durable generation solved, schema-guaranteed specs.
- *Cons:* Vercel monoculture risk (Workflows/json-render/Streamdown are young — keep Postgres, LessonSpec, prompts, FSRS core vendor-neutral); LangChain itself mostly dropped.

### Approach B — LangGraph service (if LangChain is non-negotiable)
Next.js frontend + separate always-on Python LangGraph 1.0 service (most mature surface; LangGraph Platform doesn't support serverless; LangChain.js can't run on edge). LangMem patterns available.
- *Pros:* founder's preferred ecosystem end-to-end; best graph/checkpoint primitives.
- *Cons:* second service with its own deploys/auth/monitoring; two languages; slower to MVP. **Verdict: only if you want it.**

### Approach C — Buy the generative layer (Thesys C1 + mem0 platform)
- *Pros:* fastest demo. *Cons:* vendor lock-in on the rendering layer, can't express custom animated "blue skies" lesson blocks, per-call fees on top of tokens. **Verdict: no.**

### Lesson rendering — three layers (resolves the researchers' contradiction)
1. **Layer 1 (MVP core):** streamed **markdown article flow via Streamdown** (Vercel OSS; handles unterminated markdown, KaTeX, Mermaid, streaming animations) with **fenced directives (```quiz, ```timeline, ```flashcards) mapped to a whitelisted registry of hand-built animated React blocks** (Zod-validated JSON bodies). Never compile LLM-emitted MDX (MDX = JSX = code execution).
2. **Layer 2:** app-like lessons composed via a **json-render-style block catalog** (vercel-labs/json-render: Zod catalogs, the LLM literally cannot emit outside it, progressive SpecStream rendering) once block count grows.
3. **Layer 3 (escape hatch, post-MVP):** Claude-Artifacts pattern for bespoke simulations — self-contained HTML in `sandbox="allow-scripts"` iframe (NEVER with `allow-same-origin`), CSP meta restricting script-src/connect-src to a CDN allowlist, separate serving origin in prod, postMessage-only grading bridge.

### Modality roadmap
- **MVP:** streamed articles with interactive embeds; flashcards/quizzes (ts-fsrs); TTS narration (OpenAI mini-TTS ~$0.015/min — one POST, instant multimodal feel).
- **v1.5:** conversational voice tutor (ElevenLabs Agents fastest / gpt-realtime-mini or Gemini Live cheapest; session caps — uncached realtime voice can run $5–14 per 30-min session); parameterized mini-game templates (6–10 hand-built: matching, sorting, label-the-diagram, simulation sliders — LLM fills JSON only).
- **v2:** Remotion-generated animated shorts (Lambda rendering; licensing ~$25/dev/mo over 3-person team); LLM-written Phaser 4 games in sandboxed iframes.
- **Never:** diffusion video as the default path; standalone Slidev/reveal.js (fold slides into a JSON deck schema rendered by your own React + Motion).

---

## 5. Research layer (Exa)

- **Exa /search is the right primary** (2026 surface: types instant/fast/auto/deep/deep-reasoning; contents bundled — reportedly $7/1k requests incl. full text of 10 results; /research API deprecated → use deep-reasoning; livecrawl → maxAgeHours). Firecrawl as deterministic scraper for known-canonical URLs. Abstract retrieval behind an internal interface — the category reprices constantly (Tavily acquired by Nebius 2/2026; Brave killed free tier).
- **Three-layer trust gate** (the "never trust parametric knowledge" rule fails open without it): (1) tiered per-subject domain allowlists (Tier 1 primary/official → Exa includeDomains, up to 1,200 domains), fall back to open web + blocklist only if <3 vetted sources; (2) Exa category filters; (3) Haiku LLM-as-judge vetting pass. Decide who curates allowlists — an unowned trust gate decays.
- **Cache topic dossiers, not raw searches:** key = (subject, topic, level band), pgvector similarity ≥0.92 = hit; value = vetted sources + claims + citations + glossary seeds + misconception list. Per-subject TTLs: news 24h; programming 7–14d; medicine/law 30d; science 90d+; math/history 6–12mo. Cold-cache ≈ $0.27–0.35/topic, near-zero on hits.
- **Tension to adjudicate:** cached dossiers + shared lesson skeletons boost margins but dilute the "fresh research, personalized to your mission" promises. Recommended line: share *dossiers* (facts don't change per student), always personalize *lessons* (mission framing, prior-knowledge bridges, examples).

---

## 6. Learner model & memory

**Build, don't buy.** mem0/Zep/LangMem are chat-memory engines (fuzzy LLM extraction, semantic retrieval); pedagogical state is the opposite shape — exact numeric fields (FSRS stability/difficulty, due dates, mastery levels), auditable supersession chains, scheduling queries ("which cards are due today"). Hand-rolled Postgres mirroring the teach-skill artifacts + two numeric subsystems:
- **ts-fsrs 5.x** Card state 1:1 in `review_cards` + full `review_log`.
- **Elo/Birdbrain-style mastery** per (student, concept): P(correct) = logistic(ability − difficulty), one update per attempt; plus a discrete rubric (not_introduced → introduced → practicing → evidenced → mastered) promoted by deterministic rules with the learning-record row as evidence. **Keep retention (FSRS) and mastery (Elo/rubric) as separate fields** — conflating them is the classic adaptive-learning error.
- Deterministic outcome→rating rubric (never let the LLM freestyle FSRS ratings); LLM-emitted difficulty priors for cold-start items.
- A single JSONB soft-profile column covers "what works for this student" at MVP. Borrow LangMem's one good pattern: distill memories *asynchronously after* the session, never inline.
- First-party Postgres also simplifies COPPA/FERPA posture vs shipping child data to a memory SaaS.
- **Merge the two proposed schemas deliberately before migration #1** (track-scoped vs global concepts; multi-learner households; school-account provenance flags from day one).
- **Context growth governance:** records/glossary/revisions grow monotonically — define a token budget per generation call, summarization/archival policy, and when pgvector retrieval over records replaces full hydration.

---

## 7. Safety, trust, accessibility (MVP-blocking unless noted)

1. **Prompt injection (OWASP #1 GenAI risk):** treat every Exa result and upload as hostile. Quarantined-LLM pattern (no-tools model extracts facts into a constrained schema; the privileged generator never reads raw HTML) + spotlighting + least privilege (no tool calls or learner-record writes triggered by retrieved content). The pipeline web-scrape → generation → executable interactive content → children is the textbook worst case.
2. **Citation verification as a pipeline stage:** claims bound to source spans; post-generation entailment check (claim vs cited text); unsupported claims dropped/regenerated/marked; clickable citations w/ retrieval date; per-lesson faithfulness score. **Triage to reconcile with latency** (see §9 open question: sync vs async-with-badges).
3. **Moderation at three points:** request, retrieved content, generated lesson — free first-pass API + custom-policy LLM judge for age-banding; human review queue; audit log. Plus (critic flags): CSAM detection/NCMEC obligations on uploads; a dual-use topics policy (lock-picking, explosives chemistry, hacking); crisis-escalation runbook; liability disclaimers + stricter sourcing for medical/legal/financial topics.
4. **Accessibility at generation time** (can't retrofit per-lesson UI): WCAG 2.2 AA; `prefers-reduced-motion` as a design-token-level switch (the blue-skies animation brand must honor it); captions piped from the TTS script; DOM/ARIA-based (not canvas) interactive blocks; axe-core scans per lesson.
5. **Reading level: measure-and-regenerate**, not "write for a 10-year-old" prompts (LLMs reliably overshoot vocabulary) — Flesch-Kincaid + age-of-acquisition scoring, regenerate flagged sentences, manual "simpler/deeper" control writing back to the learner model. (English-centric metrics — see i18n gap.)
6. **The learner model is sensitive data** (a map of a person's gaps and aspirations): minimize (structured records, transcripts auto-expire ~90d), purpose-limit (never ads, never training, never sold), self-service export (JSON + Markdown — market it: "your learning record belongs to you"), one-click cascading delete **with a stated backup-retention policy** (deletes don't propagate to PITR backups by magic).
7. **Voice lessons ephemeral by design:** stream → transcript → delete audio immediately (child audio is now COPPA personal information).

---

## 8. Integrations & economics

**Integrations build order:** (1) drag-drop upload at MVP — 90% of value, 10% of cost, zero review queues; (2) **Notion EXPORT** of lessons/glossaries/reference docs — the flagship integration; matches the durable-artifacts philosophy; no Notion approval needed for a public OAuth integration (Marketplace listing optional later); chunk for limits (~3 req/s, 100 blocks/append); (3) Drive import via **`drive.file` + Picker only — never `drive.readonly`** (restricted scope = recurring CASA audit $540–$1.8k+/yr + weeks–months review; drive.file is non-sensitive, ~3-day brand verification); (4) Notion import; (5) Classroom/Canvas LTI post-PMF. Gate all integrations adult-only initially (child-data disclosure requires separate VPC).

**Economics (unreconciled across researchers — rebuild one cost model before pricing):** estimates ranged $0.11–$2.50/lesson depending on model tier and caching assumptions. Levers that survive any model: prompt caching of the static pedagogy+catalog prefix (~90% input discount on Anthropic); cross-student dossier cache; budget-model drafting + frontier pedagogy-review pass; credit metering under a subscription (pure flat-rate fails: documented 8%-of-users-eat-61%-of-cost case). Market anchors: Khanmigo $4/mo, Brilliant ~$13.5, Opennote $15, Math Academy $49. Suggested: free ~3 lessons/mo → $15/mo Learner (credits) → $30–49 power tier.

**Landscape:** the gap hypothesis holds — chat tutors (Study Mode, Gemini Guided Learning, Khanmigo) own Socratic chat; nobody combines on-demand arbitrary-topic generation + durable multimodal artifacts + fresh cited research + persistent learner record. Google's "Learn Your Way" RCT (multi-format generated lessons beat PDFs on 3-day retention) is direct scientific validation — and Google is one product decision from collapsing the differentiation, so **defensibility = the learner record + mission loop + artifacts, not generation quality**. Closest indie: Opennote (YC S25, ~55k students, $15/mo). Generation-latency UX: outline in ~1s → visible research feed ("Reading nih.gov…") → blocks fill top-down → background + notify for slow assets (NotebookLM pattern).

---

## 9. Gaps nobody covered (the critic's list — each needs an owner)

Auth/accounts (provider, parent-child linking, family plans, anonymous→account migration, school SSO) · billing infra (Stripe vs merchant-of-record for global VAT; credit ledger with holds/refunds) · **notifications/email/push — the entire FSRS retention loop is dead without it** (and marketing-style pushes to minors are restricted) · i18n (allowlists, readability metrics, TTS/captions are all English-centric today; "any background" isn't) · offline/PWA/mobile (offline flashcard review + FSRS sync conflicts; native app = App Store kids rules + 30% cut) · **copyright/IP** (lessons are derivative of scraped sources; DMCA agent; CC-BY attribution; *images* — scraped is high-risk, decide generated vs licensed; purely AI-generated output isn't copyrightable, which touches "artifacts the student keeps") · lesson sharing/marketplace + acquisition strategy (public lesson pages = programmatic SEO, but moderation/child-privacy/copyright at scale) · **eval harness** (golden set per topic×age×format in CI; LLM-judge pedagogy rubrics; regression gates before model swaps; primary metric = delayed retention; child-safe analytics) · assessment integrity (LLM-graded answers are paste-into-ChatGPT cheatable — matters the moment you issue parent reports or certificates) · model lifecycle/provider fallback (AI Gateway routing; re-verification of cached content after model swaps) · cold-start (anonymous demo lesson costs $0.30–0.90 — abuse controls; pre-generated showcase gallery) · input modality for emerging readers (children's ASR is weak; voice/icon-first onboarding) · community-recommendation ops (vetted forums rot; v1 = named major communities + local-class suggestions only).

---

## 10. Open questions (founder decisions — full list)

1. **Launch audience:** 13+ first (consensus) with Kids mode later — or kids-first, which inverts the roadmap (VPC + parent accounts become build item #1)?
2. **Buyer at launch:** the learner, or a parent buying for a child? (Determines auth model, first dashboard, pricing page.)
3. **Beachhead:** truly "anything," or 3–5 curated verticals where allowlists/evals/templates can be hand-tuned? Who curates allowlists ongoing?
4. **North-star metric:** delayed retention/evidenced mastery (honest, slow) vs engagement (fast, gameable)?
5. **Citations promise wording:** "verified before you see it" (sync, slower, costlier) vs "cited + continuously verified with badges/corrections" (async + quarantine)?
6. **Lessons private or shareable/public?** (Strongest acquisition loop vs moderation/privacy/copyright at scale. Marketplace ever?)
7. **Methodology fidelity vs activation:** accept "just curious" missions, ≤2 follow-ups, lesson #1 before curation completes?
8. **Pricing posture:** ~$15/mo + credits + small free tier? Anonymous try-before-signup demo lesson?
9. **Confirm: "animated" = code-rendered only** (Remotion/SVG/blocks), no diffusion video in the default path?
10. **Voice scope v1:** TTS narration only, or conversational voice tutor despite cost/ops/SB-243 exposure?
11. **English-only at launch?** If not, which 2–3 languages, knowing the trust/readability tooling gap?
12. **Mobile:** responsive web + PWA for v1, or native (kids-category rules, 30% cut)?
13. **Vendor posture:** all-Vercel + Anthropic-only for velocity, or multi-provider seams from day one?
14. **Will the product ever assert mastery to third parties** (parent reports, certificates)? If yes, assessment integrity moves up.
15. **Public data promises:** "no training on learner data, export anytime, one-click delete"? Transcript retention default (90d proposed)? Real monthly infra + legal budget — what gets cut to ship?
16. **Notion/Drive in the first six months** (researchers say no — upload + PDF export covers it), or is Notion export core to positioning?
