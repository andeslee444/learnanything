# LearnAnything

AI-generated learning platform: any student types what they want to learn and receives custom multi-modal lessons grounded in fresh, cited web research — built on a mission-driven methodology with a persistent learner model.

- Design spec: `docs/superpowers/specs/2026-06-09-learnanything-v1-design.md`
- Current phase: 1 (foundation) — see `docs/superpowers/plans/2026-06-09-phase-1-foundation.md`

## Setup

```bash
cp .env.example .env && cp .env.example .env.local  # fill BETTER_AUTH_SECRET via: openssl rand -base64 32
docker compose up -d
npm install
npm run dev
```
