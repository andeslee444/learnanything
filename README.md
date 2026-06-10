# LearnAnything

AI-generated learning platform: any student types what they want to learn and receives custom multi-modal lessons grounded in fresh, cited web research — built on a mission-driven methodology with a persistent learner model.

- Design spec: `docs/superpowers/specs/2026-06-09-learnanything-v1-design.md`
- Current phase: 3 (research layer) — see `docs/superpowers/plans/2026-06-10-phase-3-research-layer.md`

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
