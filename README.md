# LearnAnything

AI-generated learning platform: any student types what they want to learn and receives custom multi-modal lessons grounded in fresh, cited web research — built on a mission-driven methodology with a persistent learner model.

- Design spec: `docs/superpowers/specs/2026-06-09-learnanything-v1-design.md`
- Current phase: 10 (public sharing, corrections propagation, DMCA takedown docs)

## Founder follow-ups (deploy checklist)

Everything below degrades gracefully when unset — tests and CI never need these.

| Variable | Enables | Without it |
|---|---|---|
| `OPENAI_API_KEY` | Live TTS narration (gpt-4o-mini-tts) | Deterministic 1s silent WAV |
| `RESEND_API_KEY` | Real email delivery via Resend | `[email:log]` console transport |
| `NOTIFY_FROM` | Custom From address | `LearnAnything <onboarding@resend.dev>` |
| `CRON_SECRET` | Cron endpoints (review digest, mission report) | Endpoints 401 (fail closed) |
| `STRIPE_SECRET_KEY` | Live Stripe billing | Billing page shows "not configured" |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification | Webhook 503 (fail closed) |
| `STRIPE_PRICE_ID` | The $15/mo subscription price | Checkout 503 |
| `APP_URL` | Checkout/portal redirect URLs | `http://localhost:3000` |
| `CONTACT_EMAIL` | Contact address on /privacy + /terms + legal DMCA contact | Generic fallback text — **required in prod before first public share** |

Stripe setup (one-time, in the Stripe dashboard): create a recurring $15/mo Price and put its id in `STRIPE_PRICE_ID`; add a webhook endpoint pointing at `/api/billing/webhook` subscribed to `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`, and copy its signing secret into `STRIPE_WEBHOOK_SECRET`. Subscription grants 30 credits/month (`SUBSCRIPTION_MONTHLY_CREDITS` in `src/lib/stripe.ts` — retune freely).

**DMCA agent registration (required before first public share):** Register a DMCA Designated Agent with the US Copyright Office at <https://www.copyright.gov/dmca-directory/> ($6 fee, renew every 3 years). Set `CONTACT_EMAIL` to the registered agent's contact address. Safe-harbour protection under 17 U.S.C. § 512 requires this registration to be active before users can share public lessons. See `docs/takedown-process.md` for the full notice/counter-notice procedure and repeat-infringer policy.

Other launch items: **/privacy and /terms are templates pending legal review — have counsel review before public launch.** Set `CRON_SECRET` in Vercel env — `vercel.json` schedules the two cron routes. Signup has no email-verification flow, so digests go to unverified addresses — add verification before scaling sends (sender-reputation risk).

**CC-BY deviation (spec §7, v1):** spec §7 requires CC-BY attribution and per-generator quote caps on public lesson pages. v1 does NOT implement these — it relies on paraphrase-only generation and citation links on public pages instead. License-aware attribution (license metadata on dossier sources + required-format CC-BY attribution rendered on /learn pages) and generator-specific quote caps are tracked as a pre-scale follow-up before the first high-traffic public launch.

**Known fast-follows:** ShareButton does not hydrate shared state on page reload — re-clicking Share is idempotent and free for already-approved rows (no LLM re-run), so the UX cost is low. Public-page caching (s-maxage / CDN) is deliberately omitted in v1 to keep unpublish latency zero — add it once the DMCA/takedown SLA is defined.

## Setup

```bash
cp .env.example .env && cp .env.example .env.local  # fill BETTER_AUTH_SECRET via: openssl rand -base64 32
docker compose up -d
npm install
npm run dev
```

## Research layer (Phase 3)

`researchTopic()` turns `(vertical, topic, levelBand)` into a cached, trust-gated, citation-ready topic dossier. It is the data source for Phase 4's lesson pipeline.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `EXA_API_KEY` | Live runs only | From [dashboard.exa.ai](https://dashboard.exa.ai). Not needed when `AI_FAKE_LLM=1`. |
| `AI_GATEWAY_API_KEY` | Live runs only | AI gateway key for LLM calls (vet, extract, synthesize, moderate). |
| `AI_FAKE_LLM` | Dev / CI | Set to `1` to use canned fixture responses — no Exa or LLM calls, no money spent. |

### Trust-gate model

Sources pass through three layers before any content reaches the synthesizer:

1. **Allowlist pass** — Exa search scoped to founder-curated tier-1/tier-2 domains (pre-trusted, no vetting needed).
2. **Open-web pass** — if fewer than 3 trusted sources, a second search excludes the global blocklist and LLM-vets unknowns.
3. **Never parametric-only** — if both passes yield fewer than 3 trusted sources, research returns `insufficient_sources` rather than proceeding without grounding.

Raw page text is quarantine-extracted per source; the synthesizer and everything downstream see only schema-constrained extractions. Sources whose extraction is flagged by moderation are dropped from both the extractions and the dossier's `sources` citation list.

### Commands

```bash
# Seed the founder-curated allowlist/blocklist (~60 domains; idempotent — safe to run again):
npm run seed:trust

# Live smoke test (requires EXA_API_KEY + AI_GATEWAY_API_KEY; spends real money — founder use only):
npm run research:smoke -- "python variables for beginners" programming novice

# Run all tests (fake mode — no external calls):
npm test
```
