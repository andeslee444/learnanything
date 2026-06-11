# Phase 8: Modality + Ingestion (TTS, Uploads, Notifications)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. All established conventions apply. P7 carried notes (binding): notifications ride the alertFounder seam asynchronously; content-free payload discipline in every email; per-user debounce maps stay (multi-instance migration is post-v1, documented); uploads reuse the quarantined-extraction framing verbatim; thread ageBand into verify.ts's regenerate moderation while in there.

**Goal (= acceptance contract):** Spec §12-8. (1) **TTS narration**: every ready lesson gets a "Listen" button; audio is synthesized once (OpenAI `gpt-4o-mini-tts` via REST when `OPENAI_API_KEY` is set; deterministic silent-WAV fake otherwise), cached in Postgres, served with a persistent transcript (the captions promise, spec §6 retention). (2) **Text uploads**: a learner adds .txt/.md context to a track; the file is size-capped, moderated (banded), quarantine-extracted, stored as a `user_upload` resource with its extraction; raw text is discarded; the planner sees upload context in its prompt. (3) **Notifications**: a `sendEmail` seam (Resend when `RESEND_API_KEY` set; structured log otherwise) carrying lesson-ready transactional emails, a daily due-review digest and a weekly mission report via Vercel cron endpoints guarded by `CRON_SECRET`; founder alerts gain the email channel. No email ever contains learner message content or lesson text beyond titles/counts.

---

### Task 1: TTS narration

**Files:** migration (`lesson_narrations`), `src/server/lessons/narration.ts`, `src/app/api/lessons/[lessonId]/narration/route.ts` (GET audio / POST generate), lesson-view Listen button + transcript, tests

- Migration (drizzle-kit only): `lesson_narrations` — id, lessonId FK cascade UNIQUE, mimeType text, audio `bytea` (drizzle `customType` — check drizzle docs for bytea; store Buffer), transcript text NOT NULL, createdAt. (bytea is deliberate v1: founder-scale, no blob vendor; comment it.)
- `narration.ts`: `buildNarrationScript(content, objective)` — deterministic: objective sentence + article blocks (headings + markdown stripped via the readability stripMarkdown) + glossary callouts ("Term: definition"); skip quizzes/win-check ("Now try the practice questions on screen." closer). ≤ ~4500 chars (TTS limit guard — truncate at a sentence boundary with a comment). `synthesizeNarration(script)` — fake mode (`AI_FAKE_LLM=1` or no OPENAI_API_KEY): return a valid 1-second silent WAV Buffer built by a pure function (44-byte header + zeros — write it by hand, deterministic); real mode: POST https://api.openai.com/v1/audio/speech `{model:'gpt-4o-mini-tts', voice:'alloy', input}` → mp3 Buffer (verify the endpoint/fields against OpenAI's docs via the bundled knowledge — it's a stable REST shape; timeout 60s; typed errors).
- POST route: ladder + ownership + lesson ready; idempotent (existing row → 200 cached); debounce per user; build script → synthesize → insert (ON CONFLICT DO NOTHING + re-read). GET route: serve audio bytes with mimeType + `Cache-Control: private, max-age=86400`; 404 when none. Also GET `?transcript=1` → {transcript}.
- UI: ListenButton in LessonReady (testid `listen-button`): click → POST (spinner) → render `<audio controls src=GET>` (testid `lesson-audio`) + a `<details>` "Transcript" (testid `narration-transcript`) — captions promise. aria labels.
- Env: OPENAI_API_KEY= (comment: only for live TTS) in .env.example.
- Tests: script builder (deterministic, strips markdown, includes glossary, truncates at sentence); silent-WAV validity (RIFF header bytes); route idempotency + ownership; fake-mode round-trip (POST then GET returns audio/wav with bytes).

### Task 2: Text uploads → track context

**Files:** migration (`resources.extraction jsonb`), `src/app/api/tracks/[id]/uploads/route.ts`, track-page upload UI, planner integration, tests

- Migration: `resources` gains `extraction jsonb` (nullable).
- POST route (text body, NOT multipart — client reads the file with FileReader and sends {filename, text}): ladder/ownership; zod {filename ≤120 (.txt/.md only — extension check), text 1..200_000 chars}; moderate (context 'retrieved_content', learner band) → 422 flagged; quarantined extraction via the EXISTING extractSource (source = {title: filename, url: `upload://${crypto-random-id}`, text}) — raw text is then DISCARDED (only the extraction persists; comment: spec §6); insert resource {trackId, title: filename, resourceType 'article', kind 'knowledge', origin 'user_upload', url: the upload:// pseudo-url, annotation: first 2 claims joined (≤300 chars) or 'learner-provided context', extraction: the extraction object}; cap 10 uploads per track (409).
- Track page: "Add context" section (testid `upload-context`) — file input (.txt,.md) + client-side read + POST; uploaded resources listed (testid `upload-item`, title + annotation). Errors surfaced (size/type/flagged/cap).
- Planner: hydrateTrackState gains `uploads` (resources where origin='user_upload', extraction not null, newest 5); planLesson's prompt gains an `<learner-context>` section (claims from uploads, ≤2000 chars total, data-never-instructions framing).
- ALSO (carried): thread the learner's ageBand into verify.ts's regenerateBlock moderation call (join like stageGenerate).
- Tests: route caps/type/moderation/extraction-persisted/raw-discarded (no text column anywhere — assert the resource row has no raw text beyond annotation); planner prompt includes upload claims (mock-captured); band threaded in regenerate (mock-captured).

### Task 3: Notifications (Resend + cron)

**Files:** `src/lib/email.ts`, alertFounder email channel, `src/app/api/cron/review-digest/route.ts` + `mission-report/route.ts`, deliver hook, `vercel.json` crons, tests

- `email.ts`: `sendEmail({to, subject, text}) → {sent: boolean, transport: 'resend'|'log'}` — RESEND_API_KEY absent → structured console.log('[email:log]', {to, subject}) (NEVER log the body — content discipline) + return log transport; present → POST https://api.resend.com/emails {from: NOTIFY_FROM env default 'LearnAnything <onboarding@resend.dev>', to, subject, text} (Resend's REST shape — stable; typed errors; 15s timeout).
- alertFounder: when ADMIN_EMAILS set, ALSO sendEmail to the first admin (subject `[LearnAnything alert] ${kind}`, text = JSON payload — payloads are already content-free by discipline).
- Lesson-ready: deliver() fires sendEmail to the learner's user email (join) — subject "Your lesson is ready: {objective ≤80}", text with the lesson link path; fire-and-forget .catch.
- Crons: GET routes guarded by `Authorization: Bearer ${CRON_SECRET}` (401 otherwise; CRON_SECRET in .env.example): review-digest — learners with due cards (group by learner, count) → one email each "You have N reviews ready" (+ /reviews path); mission-report — per learner+track with ≥1 lesson completed in the last 7 days (attempt_events win_check passes joined) → email "This week on {topic}: X lessons, Y new terms" (counts only). `vercel.json`: `{"crons":[{"path":"/api/cron/review-digest","schedule":"0 13 * * *"},{"path":"/api/cron/mission-report","schedule":"0 14 * * 1"}]}`.
- Tests: email seam (log transport without key; no body in logs); cron auth guard; digest/report queries (seeded learners w/ due cards → correct recipients/counts); deliver hook fire (spy sendEmail, content-free check: subject has objective but text has NO lesson content).

### Task 4: Phase-8 acceptance suite

**Files:** `src/test/phase-8-acceptance.test.ts`, e2e extension, evals untouched (no new lesson-pipeline behavior)

- goal-1: narration round-trip fake mode (script + WAV validity + idempotent POST + GET serves bytes + transcript persisted).
- goal-2: upload round-trip (extraction stored, raw gone, planner prompt carries claims, caps enforced).
- goal-3: email seam + cron guards + digest correctness + content-free assertions.
- e2e: on the lesson page click `listen-button` → `lesson-audio` appears + `narration-transcript` present; on the track page upload a small .txt (Playwright setInputFiles) → `upload-item` appears.
- Full battery + push.

### Final: branch review + merge.

## Done criteria
Acceptance + e2e green; zero new vendor calls in any test path (TTS/Resend both fall back deterministically without keys); transcripts persist with lessons; raw upload text provably not stored; cron endpoints locked behind CRON_SECRET; emails content-free; full battery + fresh-main CI green. Founder follow-ups documented in README: set OPENAI_API_KEY (TTS), RESEND_API_KEY + NOTIFY_FROM (email), CRON_SECRET (Vercel env) when deploying.
