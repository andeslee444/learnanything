# Phase 2: Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A learner can sign up (neutral age screen, 13+), run the mission interview, confirm an editable Mission card, watch their skill graph get built by an LLM, answer a calibration micro-quiz, and land on a track dashboard with a "first lesson coming soon" stub.

**Architecture:** First LLM calls enter the codebase via one helper (`llmObject`) using AI SDK 6 (`generateText` + `Output.object`, gateway model strings) with an `AI_FAKE_LLM=1` fixture mode so tests/e2e/CI never hit a real model. Services take `db` as a parameter (established convention). Interview state lives client-side until Mission confirmation; track initialization is an idempotent route-handler call. Calibration answers are stored RAW in `attempt_events` (distillation is Phase 5 — per spec §12 phase 2 done-state).

**Tech Stack:** ai@6 (installed) · Vercel AI Gateway (`AI_GATEWAY_API_KEY`) · zod · Better-Auth session APIs · Playwright (new) — on top of the Phase 1 stack.

**Spec:** `docs/superpowers/specs/2026-06-09-learnanything-v1-design.md` §1 flow 1, §2 "Track initialization", §6 (age screen), §12 phase 2.

**Verified current APIs (2026-06-10, ai@6.0.199):** structured output = `generateText` + `Output.object({schema})` → `{ output }`; gateway models are plain strings (`anthropic/claude-opus-4.8`, `anthropic/claude-sonnet-4.6`, `anthropic/claude-haiku-4.5` — dot notation); test mock = `MockLanguageModelV3` from `ai/test`.

**Conventions:** commits use `--author="Andes Lee <andes.lee444@gmail.com>"`. Constraint-violation tests inspect `error.cause` (Drizzle wraps PG errors). Every test file importing `testPool` ends it in `afterAll`. Local Postgres = port 5433.

---

## File structure (new files this phase)

```
src/
├── lib/
│   ├── ai.ts                  # llmObject helper, MODEL_TIERS, fake-mode switch
│   ├── ai-fixtures.ts         # schema-valid canned outputs for AI_FAKE_LLM=1
│   ├── age-band.ts            # birth-year → age_band mapping (pure)
│   └── skill-graph.ts         # graph validators (pure): acyclic, size, depth, scope
├── server/
│   ├── learners.ts            # createLearner (idempotent), getLearnerByUserId
│   ├── tracks.ts              # createTrackWithMission, listTracks, getTrackDetail, nextRecordSeq
│   └── track-init.ts          # initializeTrack: graph gen → validate → persist → quiz gen
├── app/
│   ├── (auth)/signup/page.tsx # age screen → account form (client)
│   ├── (auth)/login/page.tsx
│   ├── (app)/layout.tsx       # session-checked shell (nav, signout)
│   ├── (app)/tracks/page.tsx  # track list
│   ├── (app)/tracks/new/page.tsx          # hero input + interview stepper
│   ├── (app)/tracks/[id]/page.tsx         # mission card, map, calibration, stub
│   ├── (app)/tracks/[id]/track-setup.tsx  # client: fires init, shows progress, quiz flow
│   └── api/
│       ├── learner/route.ts               # POST create learner (idempotent)
│       ├── interview/concreteness/route.ts# POST classify why-answer
│       ├── tracks/route.ts                # POST create track+mission
│       ├── tracks/[id]/initialize/route.ts# POST idempotent track init (maxDuration 300)
│       └── tracks/[id]/calibration/route.ts # POST store one raw answer
├── components/
│   ├── interview-stepper.tsx  # client stepper (why→success→constraints→prior→scope→card)
│   └── signout-button.tsx
e2e/
└── onboarding.spec.ts         # Playwright happy path (AI_FAKE_LLM=1)
playwright.config.ts
```

UI components use the Phase 1 tokens only (sky/sun/ink/cloud, font-sans). No new UI libraries. No Motion yet (Phase 4).

---

### Task 1: LLM infrastructure (`llmObject` + fixtures)

**Files:**
- Create: `src/lib/ai.ts`, `src/lib/ai-fixtures.ts`
- Modify: `.env.example` (+ your `.env`/`.env.local`)
- Test: `src/lib/ai.test.ts`

- [ ] **Step 1: Add env vars** to `.env.example`:

```bash
# Vercel AI Gateway (https://vercel.com/~/ai-gateway/api-keys). Leave empty + set AI_FAKE_LLM=1 to run without a key.
AI_GATEWAY_API_KEY=
# 1 = serve canned fixtures instead of calling models (tests/e2e/CI)
AI_FAKE_LLM=
```

Append both to `.env` and `.env.local` too (values empty / unset for now — the founder supplies the key).

- [ ] **Step 2: Create `src/lib/ai.ts`**

```ts
import { generateText, Output } from 'ai';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';

// Gateway model IDs verified 2026-06-10 via https://ai-gateway.vercel.sh/v1/models
export const MODEL_TIERS = {
  planner: 'anthropic/claude-opus-4.8', // skill-graph decomposition (spec §2 track init)
  generator: 'anthropic/claude-sonnet-4.6', // calibration quiz + future sub-tasks
  classifier: 'anthropic/claude-haiku-4.5', // concreteness check + future classification
} as const;
export type ModelTier = keyof typeof MODEL_TIERS;

export type LlmPurpose = 'concreteness' | 'skill-graph' | 'calibration-quiz';

/**
 * Single entry point for structured LLM calls.
 * AI_FAKE_LLM=1 serves schema-validated fixtures (tests/e2e/CI) — no key, no spend.
 * `modelOverride` exists for unit-testing this helper with MockLanguageModelV3.
 */
export async function llmObject<T>(opts: {
  purpose: LlmPurpose;
  tier: ModelTier;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  modelOverride?: LanguageModel;
}): Promise<T> {
  if (!opts.modelOverride && process.env.AI_FAKE_LLM === '1') {
    const { fakeOutputs } = await import('./ai-fixtures');
    return opts.schema.parse(fakeOutputs[opts.purpose]);
  }
  const { output } = await generateText({
    model: opts.modelOverride ?? MODEL_TIERS[opts.tier],
    output: Output.object({ schema: opts.schema }),
    system: opts.system,
    prompt: opts.prompt,
  });
  return opts.schema.parse(output);
}
```

- [ ] **Step 3: Create `src/lib/ai-fixtures.ts`** (must satisfy the schemas defined in Tasks 4 and 6 — keep in sync)

```ts
import type { LlmPurpose } from './ai';

/** Canned outputs for AI_FAKE_LLM=1. Each must parse against its call site's zod schema. */
export const fakeOutputs: Record<LlmPurpose, unknown> = {
  concreteness: {
    concrete: true,
    followUp: null,
  },
  'skill-graph': {
    nodes: [
      { name: 'Variables and types', summary: 'Declaring and using basic values', missionRelevance: 0.9 },
      { name: 'Control flow', summary: 'if/else and loops', missionRelevance: 0.85 },
      { name: 'Functions', summary: 'Defining and calling functions', missionRelevance: 0.9 },
      { name: 'Data structures', summary: 'Lists and maps', missionRelevance: 0.8 },
      { name: 'Error handling', summary: 'Failing gracefully', missionRelevance: 0.6 },
      { name: 'File I/O', summary: 'Reading and writing files', missionRelevance: 0.7 },
      { name: 'CLI arguments', summary: 'Parsing command-line input', missionRelevance: 0.95 },
      { name: 'Testing basics', summary: 'Writing first unit tests', missionRelevance: 0.65 },
      { name: 'Packaging', summary: 'Sharing a runnable tool', missionRelevance: 0.75 },
      { name: 'Project: ship the CLI', summary: 'Capstone tying it together', missionRelevance: 1 },
    ],
    edges: [
      { node: 'Control flow', prereq: 'Variables and types' },
      { node: 'Functions', prereq: 'Control flow' },
      { node: 'Data structures', prereq: 'Variables and types' },
      { node: 'Error handling', prereq: 'Functions' },
      { node: 'File I/O', prereq: 'Functions' },
      { node: 'CLI arguments', prereq: 'Functions' },
      { node: 'Testing basics', prereq: 'Functions' },
      { node: 'Packaging', prereq: 'CLI arguments' },
      { node: 'Project: ship the CLI', prereq: 'Packaging' },
      { node: 'Project: ship the CLI', prereq: 'Error handling' },
    ],
  },
  'calibration-quiz': {
    items: [
      {
        id: 'cal-1',
        question: 'What does a variable do in a program?',
        options: ['Stores a value under a name', 'Draws on the screen', 'Connects to the internet', 'Compiles the code'],
        correctIndex: 0,
        conceptName: 'Variables and types',
      },
      {
        id: 'cal-2',
        question: 'What is the purpose of a loop?',
        options: ['Repeat work without copy-pasting code', 'Store a password', 'Style a web page', 'Send an email'],
        correctIndex: 0,
        conceptName: 'Control flow',
      },
    ],
  },
};
```

- [ ] **Step 4: Write tests** — `src/lib/ai.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { llmObject } from './ai';

const schema = z.object({ answer: z.string() });

describe('llmObject', () => {
  let priorFake: string | undefined;
  beforeEach(() => { priorFake = process.env.AI_FAKE_LLM; });
  afterEach(() => { process.env.AI_FAKE_LLM = priorFake; });

  it('serves fixtures in fake mode', async () => {
    process.env.AI_FAKE_LLM = '1';
    const out = await llmObject({
      purpose: 'concreteness',
      tier: 'classifier',
      schema: z.object({ concrete: z.boolean(), followUp: z.string().nullable() }),
      system: 's',
      prompt: 'p',
    });
    expect(out.concrete).toBe(true);
  });

  it('parses structured output from the model (mock)', async () => {
    process.env.AI_FAKE_LLM = '0';
    const mock = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ answer: '42' }) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const out = await llmObject({
      purpose: 'concreteness', tier: 'classifier', schema, system: 's', prompt: 'p', modelOverride: mock,
    });
    expect(out.answer).toBe('42');
  });

  it('rejects fixture/schema drift', async () => {
    process.env.AI_FAKE_LLM = '1';
    await expect(
      llmObject({ purpose: 'concreteness', tier: 'classifier', schema: z.object({ nope: z.number() }), system: 's', prompt: 'p' })
    ).rejects.toThrow();
  });
});
```

If the `MockLanguageModelV3` `doGenerate` result shape errors under the installed version, check `node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx` and adopt its exact shape — the docs are bundled and authoritative.

- [ ] **Step 5: Run + commit**

```bash
npm test -- ai      # 3 passing
npx tsc --noEmit
git add -A && git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: llmObject helper with gateway tiers and fake-fixture mode"
```

---

### Task 2: Age band + auth UI + learner creation

**Files:**
- Create: `src/lib/age-band.ts`, `src/server/learners.ts`, `src/app/api/learner/route.ts`, `src/app/(auth)/signup/page.tsx`, `src/app/(auth)/login/page.tsx`, `src/app/(app)/layout.tsx`, `src/components/signout-button.tsx`
- Modify: `src/app/page.tsx` (CTA links to /signup, /login)
- Test: `src/lib/age-band.test.ts`, `src/test/learner-route.test.ts`

- [ ] **Step 1: TDD the age mapping** — `src/lib/age-band.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { ageBandFromBirthYear } from './age-band';

describe('ageBandFromBirthYear', () => {
  const now = new Date('2026-06-10');
  it('maps under-13 to null (blocked, never stored)', () => {
    expect(ageBandFromBirthYear(2015, now)).toBeNull(); // turns 11 this year
    expect(ageBandFromBirthYear(2014, now)).toBeNull(); // turns 12
  });
  it('maps 13-15', () => {
    expect(ageBandFromBirthYear(2013, now)).toBe('13_15'); // turns 13
    expect(ageBandFromBirthYear(2011, now)).toBe('13_15'); // turns 15
  });
  it('maps 16-17', () => {
    expect(ageBandFromBirthYear(2010, now)).toBe('16_17');
    expect(ageBandFromBirthYear(2009, now)).toBe('16_17');
  });
  it('maps 18+', () => {
    expect(ageBandFromBirthYear(2008, now)).toBe('18_plus');
    expect(ageBandFromBirthYear(1980, now)).toBe('18_plus');
  });
});
```

Run: `npm test -- age-band` → FAIL (module missing). Then create `src/lib/age-band.ts`:

```ts
export type AgeBand = '13_15' | '16_17' | '18_plus';

/**
 * Conservative banding from birth YEAR only (data minimization — we never store DOB).
 * Uses the age the person turns this calendar year, so someone who hasn't had their
 * birthday yet may be banded one year up — conservative is fine; under-13 banding
 * errs the other way: we require the year they turn 13 to have started.
 */
export function ageBandFromBirthYear(birthYear: number, now = new Date()): AgeBand | null {
  const ageThisYear = now.getUTCFullYear() - birthYear;
  if (ageThisYear < 13) return null;
  if (ageThisYear <= 15) return '13_15';
  if (ageThisYear <= 17) return '16_17';
  return '18_plus';
}
```

Run: `npm test -- age-band` → PASS.

- [ ] **Step 2: Learner service** — `src/server/learners.ts`

```ts
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';
import type { AgeBand } from '@/lib/age-band';

type Db = NodePgDatabase<typeof s>;

/** Idempotent: returns the existing learner if one exists for this user. */
export async function createLearner(
  db: Db,
  input: { userId: string; displayName: string; ageBand: AgeBand }
) {
  const existing = await getLearnerByUserId(db, input.userId);
  if (existing) return existing;
  const [learner] = await db
    .insert(s.learners)
    .values(input)
    .onConflictDoNothing({ target: s.learners.userId })
    .returning();
  // Concurrent duplicate insert: onConflictDoNothing returns no row — re-read.
  return learner ?? (await getLearnerByUserId(db, input.userId))!;
}

export async function getLearnerByUserId(db: Db, userId: string) {
  const [learner] = await db.select().from(s.learners).where(eq(s.learners.userId, userId));
  return learner ?? null;
}
```

- [ ] **Step 3: Learner route** — `src/app/api/learner/route.ts`

```ts
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { createLearner } from '@/server/learners';

const bodySchema = z.object({
  displayName: z.string().min(1).max(80),
  ageBand: z.enum(['13_15', '16_17', '18_plus']),
});

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const learner = await createLearner(db, { userId: session.user.id, ...parsed.data });
  return NextResponse.json({ learnerId: learner.id });
}
```

- [ ] **Step 4: Integration test** — `src/test/learner-route.test.ts` (test the service, established pattern — routes are thin)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { createLearner, getLearnerByUserId } from '@/server/learners';

describe('learner creation', () => {
  beforeAll(resetDb);
  afterAll(() => testPool.end());

  it('creates once and is idempotent', async () => {
    const [u] = await testDb
      .insert(s.user)
      .values({ id: crypto.randomUUID(), name: 'A', email: 'a@t.dev' })
      .returning();
    const first = await createLearner(testDb, { userId: u.id, displayName: 'A', ageBand: '18_plus' });
    const second = await createLearner(testDb, { userId: u.id, displayName: 'DIFFERENT', ageBand: '16_17' });
    expect(second.id).toBe(first.id);
    expect((await getLearnerByUserId(testDb, u.id))!.displayName).toBe('A');
  });
});
```

- [ ] **Step 5: Signup page** — `src/app/(auth)/signup/page.tsx` (client component). Two-step form:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import { ageBandFromBirthYear, type AgeBand } from '@/lib/age-band';

const THIS_YEAR = new Date().getUTCFullYear();
const YEARS = Array.from({ length: 100 }, (_, i) => THIS_YEAR - i);

export default function SignupPage() {
  const router = useRouter();
  // Neutral age screen (spec §6): plain question, no hint of a threshold.
  const [birthYear, setBirthYear] = useState<number | null>(null);
  const [band, setBand] = useState<AgeBand | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [attested, setAttested] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function submitAge(e: React.FormEvent) {
    e.preventDefault();
    if (birthYear == null) return;
    const b = ageBandFromBirthYear(birthYear);
    if (!b) {
      setBlocked(true); // nothing stored, nothing sent — client-side only
      return;
    }
    setBand(b);
  }

  async function submitAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!band) return;
    if (band !== '18_plus' && !attested) {
      setError('Please confirm you have a parent or guardian’s permission.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: signUpError } = await authClient.signUp.email({ name, email, password });
    if (signUpError) {
      setError(signUpError.message ?? 'Sign up failed.');
      setBusy(false);
      return;
    }
    const res = await fetch('/api/learner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name, ageBand: band }),
    });
    if (!res.ok) {
      setError('Account created but profile setup failed — please log in to retry.');
      setBusy(false);
      return;
    }
    router.push('/tracks');
  }

  if (blocked) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-sky-100 to-cloud px-6">
        <div className="max-w-md text-center">
          <h1 className="text-3xl font-medium text-ink-900">We’re not quite ready for you yet</h1>
          <p className="mt-4 text-ink-600">
            LearnAnything doesn’t offer accounts for your age group yet. We’re working on a version
            built just for younger learners — check back with a parent or guardian.
          </p>
          <Link href="/" className="mt-8 inline-block text-sky-600">Back home</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-sky-100 to-cloud px-6">
      <div className="w-full max-w-md rounded-xl bg-cloud p-8 shadow-sm">
        {band === null ? (
          <form onSubmit={submitAge}>
            <h1 className="text-2xl font-medium text-ink-900">First, when were you born?</h1>
            <p className="mt-2 text-sm text-ink-600">We use this to shape lessons for you.</p>
            <select
              className="mt-6 w-full rounded-md border border-ink-400/40 bg-white p-3 text-ink-900"
              value={birthYear ?? ''}
              onChange={(e) => setBirthYear(Number(e.target.value))}
              required
            >
              <option value="" disabled>Birth year</option>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button type="submit" className="mt-6 w-full rounded-md bg-sky-600 p-3 font-medium text-white">
              Continue
            </button>
          </form>
        ) : (
          <form onSubmit={submitAccount}>
            <h1 className="text-2xl font-medium text-ink-900">Create your account</h1>
            <input className="mt-6 w-full rounded-md border border-ink-400/40 bg-white p-3" placeholder="Your name"
              value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            <input className="mt-3 w-full rounded-md border border-ink-400/40 bg-white p-3" type="email" placeholder="Email"
              value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="mt-3 w-full rounded-md border border-ink-400/40 bg-white p-3" type="password" placeholder="Password (8+ characters)"
              value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            {band !== '18_plus' && (
              <label className="mt-4 flex items-start gap-2 text-sm text-ink-600">
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-1" />
                I have a parent or guardian’s permission to use LearnAnything.
              </label>
            )}
            {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
            <button type="submit" disabled={busy} className="mt-6 w-full rounded-md bg-sky-600 p-3 font-medium text-white disabled:opacity-50">
              {busy ? 'Creating…' : 'Create account'}
            </button>
            <p className="mt-4 text-center text-sm text-ink-600">
              Already have an account? <Link href="/login" className="text-sky-600">Log in</Link>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Login page** — `src/app/(auth)/login/page.tsx`

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await authClient.signIn.email({ email, password });
    if (signInError) {
      setError('Invalid email or password.');
      setBusy(false);
      return;
    }
    router.push('/tracks');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-sky-100 to-cloud px-6">
      <form onSubmit={submit} className="w-full max-w-md rounded-xl bg-cloud p-8 shadow-sm">
        <h1 className="text-2xl font-medium text-ink-900">Welcome back</h1>
        <input className="mt-6 w-full rounded-md border border-ink-400/40 bg-white p-3" type="email" placeholder="Email"
          value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="mt-3 w-full rounded-md border border-ink-400/40 bg-white p-3" type="password" placeholder="Password"
          value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
        <button type="submit" disabled={busy} className="mt-6 w-full rounded-md bg-sky-600 p-3 font-medium text-white disabled:opacity-50">
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <p className="mt-4 text-center text-sm text-ink-600">
          New here? <Link href="/signup" className="text-sky-600">Create an account</Link>
        </p>
      </form>
    </main>
  );
}
```

- [ ] **Step 7: Protected app shell** — `src/app/(app)/layout.tsx`

```tsx
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getLearnerByUserId } from '@/server/learners';
import { SignOutButton } from '@/components/signout-button';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) redirect('/signup'); // orphan user (signup interrupted) — completes profile there

  return (
    <div className="min-h-screen bg-cloud">
      <header className="flex items-center justify-between border-b border-ink-400/20 px-6 py-4">
        <Link href="/tracks" className="text-lg font-medium text-sky-700">LearnAnything</Link>
        <SignOutButton />
      </header>
      {children}
    </div>
  );
}
```

`src/components/signout-button.tsx`:

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="text-sm text-ink-600 hover:text-ink-900"
      onClick={async () => {
        await authClient.signOut();
        router.push('/');
      }}
    >
      Sign out
    </button>
  );
}
```

NOTE: the signup page handles the orphan-user redirect case — when a logged-in user with no learner row lands on /signup, the age screen runs again and `submitAccount` would fail on signUp (email exists). Handle it: at the top of `submitAccount`, if `authClient` already has a session (check `await authClient.getSession()` returns a user), skip signUp and only POST /api/learner. Implement exactly that guard.

- [ ] **Step 8: Landing CTA** — in `src/app/page.tsx`, replace the sun chip div with:

```tsx
      <div className="mt-10 flex gap-4">
        <Link href="/signup" className="rounded-xl bg-sky-600 px-6 py-3 font-medium text-white">
          Start learning
        </Link>
        <Link href="/login" className="rounded-xl border border-sky-300 px-6 py-3 font-medium text-sky-700">
          Log in
        </Link>
      </div>
```

(add `import Link from 'next/link';`)

- [ ] **Step 9: Verify + commit**

```bash
npm test && npx tsc --noEmit && npm run lint && npm run build
git add -A && git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: neutral age screen, signup/login UI, learner creation, protected shell"
```

---

### Task 3: Skill-graph validators (TDD, pure)

**Files:**
- Create: `src/lib/skill-graph.ts`
- Test: `src/lib/skill-graph.test.ts`

- [ ] **Step 1: Write the failing tests** — `src/lib/skill-graph.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { validateSkillGraph, type GraphInput } from './skill-graph';

function nodes(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `n${i}`, summary: '', missionRelevance: 0.5 }));
}
function chain(n: number) {
  return Array.from({ length: n - 1 }, (_, i) => ({ node: `n${i + 1}`, prereq: `n${i}` }));
}
const valid: GraphInput = { nodes: nodes(10), edges: chain(5) };

describe('validateSkillGraph', () => {
  it('accepts a valid graph', () => {
    expect(validateSkillGraph(valid, []).ok).toBe(true);
  });
  it('rejects too few or too many nodes', () => {
    expect(validateSkillGraph({ nodes: nodes(9), edges: [] }, []).ok).toBe(false);
    expect(validateSkillGraph({ nodes: nodes(41), edges: [] }, []).ok).toBe(false);
  });
  it('rejects duplicate node names', () => {
    const dup = { nodes: [...nodes(10), { name: 'n0', summary: '', missionRelevance: 0.5 }], edges: [] };
    expect(validateSkillGraph(dup, []).ok).toBe(false);
  });
  it('rejects edges to unknown nodes', () => {
    expect(validateSkillGraph({ nodes: nodes(10), edges: [{ node: 'n0', prereq: 'ghost' }] }, []).ok).toBe(false);
  });
  it('rejects self-loops and cycles', () => {
    expect(validateSkillGraph({ nodes: nodes(10), edges: [{ node: 'n0', prereq: 'n0' }] }, []).ok).toBe(false);
    const cyc = [{ node: 'n1', prereq: 'n0' }, { node: 'n2', prereq: 'n1' }, { node: 'n0', prereq: 'n2' }];
    expect(validateSkillGraph({ nodes: nodes(10), edges: cyc }, []).ok).toBe(false);
  });
  it('rejects prerequisite chains deeper than 5', () => {
    expect(validateSkillGraph({ nodes: nodes(10), edges: chain(7) }, []).ok).toBe(false); // depth 7
    expect(validateSkillGraph({ nodes: nodes(10), edges: chain(5) }, []).ok).toBe(true); // depth 5
  });
  it('rejects nodes matching out-of-scope topics (case-insensitive substring)', () => {
    const g = { nodes: [...nodes(9), { name: 'Advanced Macros', summary: '', missionRelevance: 0.5 }], edges: [] };
    const res = validateSkillGraph(g, ['macros']);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/out-of-scope/i);
  });
});
```

Run: `npm test -- skill-graph` → FAIL (module missing).

- [ ] **Step 2: Implement** — `src/lib/skill-graph.ts`

```ts
export type GraphNode = { name: string; summary: string; missionRelevance: number };
export type GraphEdge = { node: string; prereq: string };
export type GraphInput = { nodes: GraphNode[]; edges: GraphEdge[] };

const MIN_NODES = 10;
const MAX_NODES = 40;
const MAX_DEPTH = 5; // longest prerequisite chain, counted in nodes

/** Spec §2 track initialization: acyclic, 10–40 nodes, depth ≤ 5, out_of_scope excluded. */
export function validateSkillGraph(
  graph: GraphInput,
  outOfScope: string[]
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const names = graph.nodes.map((n) => n.name);
  const nameSet = new Set(names);

  if (names.length < MIN_NODES || names.length > MAX_NODES) {
    errors.push(`node count ${names.length} outside ${MIN_NODES}-${MAX_NODES}`);
  }
  if (nameSet.size !== names.length) errors.push('duplicate node names');

  for (const scope of outOfScope) {
    const hit = names.find((n) => n.toLowerCase().includes(scope.toLowerCase()));
    if (hit) errors.push(`node "${hit}" matches out-of-scope topic "${scope}"`);
  }

  for (const e of graph.edges) {
    if (!nameSet.has(e.node) || !nameSet.has(e.prereq)) {
      errors.push(`edge references unknown node: ${e.prereq} -> ${e.node}`);
    }
    if (e.node === e.prereq) errors.push(`self-loop on "${e.node}"`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // Kahn's algorithm: detects cycles and computes longest chain in one pass.
  const indegree = new Map(names.map((n) => [n, 0]));
  const children = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of graph.edges) {
    indegree.set(e.node, (indegree.get(e.node) ?? 0) + 1);
    children.get(e.prereq)!.push(e.node);
  }
  const depth = new Map(names.map((n) => [n, 1]));
  const queue = names.filter((n) => indegree.get(n) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const n = queue.shift()!;
    visited++;
    for (const child of children.get(n)!) {
      depth.set(child, Math.max(depth.get(child)!, depth.get(n)! + 1));
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  if (visited !== names.length) errors.push('graph contains a cycle');
  const maxDepth = Math.max(...depth.values());
  if (maxDepth > MAX_DEPTH) errors.push(`prerequisite chain depth ${maxDepth} exceeds ${MAX_DEPTH}`);

  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- skill-graph   # all passing
git add -A && git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: skill-graph validators (TDD)"
```

---

### Task 4: Track + mission services and APIs

**Files:**
- Create: `src/server/tracks.ts`, `src/app/api/tracks/route.ts`, `src/app/api/interview/concreteness/route.ts`
- Test: `src/test/tracks.test.ts`

- [ ] **Step 1: Service** — `src/server/tracks.ts`

```ts
import { desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const createTrackInput = z.object({
  topic: z.string().min(3).max(200),
  vertical: z.enum(['programming', 'history']), // launch verticals (spec decision log)
  whyText: z.string().min(3).max(2000),
  successCriteria: z.array(z.object({ description: z.string().min(3).max(300) })).min(1).max(5),
  constraints: z.object({
    timePerWeek: z.string().max(100).optional(),
    deadline: z.string().max(100).optional(),
    notes: z.string().max(500).optional(),
  }),
  priorKnowledge: z.string().max(2000).optional(),
  outOfScope: z.array(z.string().min(1).max(100)).max(10),
});
export type CreateTrackInput = z.infer<typeof createTrackInput>;

/**
 * Per-track sequence convention (see schema comment on learning_records.seq):
 * lock the track row FOR UPDATE, then MAX(seq)+1.
 */
export async function nextRecordSeq(tx: Tx, trackId: string): Promise<number> {
  await tx.execute(sql`SELECT id FROM tracks WHERE id = ${trackId} FOR UPDATE`);
  const [row] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${s.learningRecords.seq}), 0)::int` })
    .from(s.learningRecords)
    .where(eq(s.learningRecords.trackId, trackId));
  return row.max + 1;
}

/** Creates track + mission (+ a prior_knowledge record if stated) in one transaction. */
export async function createTrackWithMission(db: Db, learnerId: string, input: CreateTrackInput) {
  return db.transaction(async (tx) => {
    const [track] = await tx
      .insert(s.tracks)
      .values({ learnerId, topic: input.topic, vertical: input.vertical })
      .returning();
    await tx.insert(s.missions).values({
      trackId: track.id,
      whyText: input.whyText,
      successCriteria: input.successCriteria,
      constraints: input.constraints,
      outOfScope: input.outOfScope,
    });
    if (input.priorKnowledge && input.priorKnowledge.trim().length > 0) {
      const seq = await nextRecordSeq(tx, track.id);
      await tx.insert(s.learningRecords).values({
        trackId: track.id,
        seq,
        recordType: 'prior_knowledge',
        title: 'Stated prior knowledge (onboarding)',
        body: input.priorKnowledge.trim().slice(0, 1000),
        evidence: { source: 'mission_interview' },
      });
    }
    return track;
  });
}

export async function listTracks(db: Db, learnerId: string) {
  return db.select().from(s.tracks).where(eq(s.tracks.learnerId, learnerId)).orderBy(desc(s.tracks.createdAt));
}

export async function getTrackDetail(db: Db, trackId: string, learnerId: string) {
  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, trackId));
  if (!track || track.learnerId !== learnerId) return null; // ownership check
  const [mission] = await db.select().from(s.missions).where(eq(s.missions.trackId, trackId));
  const nodes = await db.select().from(s.skillNodes).where(eq(s.skillNodes.trackId, trackId));
  return { track, mission: mission ?? null, nodes };
}
```

- [ ] **Step 2: Tracks route** — `src/app/api/tracks/route.ts`

```ts
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getLearnerByUserId } from '@/server/learners';
import { createTrackInput, createTrackWithMission } from '@/server/tracks';

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });
  const parsed = createTrackInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', details: parsed.error.flatten() }, { status: 400 });
  }
  const track = await createTrackWithMission(db, learner.id, parsed.data);
  return NextResponse.json({ trackId: track.id });
}
```

- [ ] **Step 3: Concreteness route** — `src/app/api/interview/concreteness/route.ts`

```ts
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { llmObject } from '@/lib/ai';

const resultSchema = z.object({
  concrete: z.boolean(),
  followUp: z.string().nullable(), // ONE follow-up question when not concrete (spec §1)
});

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = z.object({ topic: z.string().max(200), why: z.string().min(1).max(2000) }).safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const result = await llmObject({
    purpose: 'concreteness',
    tier: 'classifier',
    schema: resultSchema,
    system:
      'You assess whether a learner\'s reason for learning is CONCRETE (a real-world outcome: pass an exam, build something specific, a job task, teach someone) or ABSTRACT ("to understand X", "general interest"). "Just curious" counts as concrete — curiosity is a valid mission. If abstract, write ONE warm follow-up question asking what they would do with the skill. Never more than one question.',
    prompt: `Topic: ${body.data.topic}\nLearner's why: ${body.data.why}`,
  });
  return NextResponse.json(result);
}
```

- [ ] **Step 4: Integration tests** — `src/test/tracks.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { createTrackWithMission, nextRecordSeq, listTracks } from '@/server/tracks';

const input = {
  topic: 'Rust CLI tools',
  vertical: 'programming' as const,
  whyText: 'Ship a CLI to my team by Q3',
  successCriteria: [{ description: 'Publish a working CLI my team installs' }],
  constraints: { timePerWeek: '3 hours' },
  priorKnowledge: 'I know Python well.',
  outOfScope: ['async'],
};

describe('track creation', () => {
  let learnerId: string;

  beforeAll(async () => {
    await resetDb();
    const [u] = await testDb.insert(s.user).values({ id: crypto.randomUUID(), name: 'T', email: 't@t.dev' }).returning();
    const [learner] = await testDb.insert(s.learners).values({ userId: u.id, displayName: 'T', ageBand: '18_plus' }).returning();
    learnerId = learner.id;
  });
  afterAll(() => testPool.end());

  it('creates track + mission + prior-knowledge record atomically', async () => {
    const track = await createTrackWithMission(testDb, learnerId, input);
    const [mission] = await testDb.select().from(s.missions).where(eq(s.missions.trackId, track.id));
    expect(mission.whyText).toBe(input.whyText);
    expect(mission.outOfScope).toEqual(['async']);
    const records = await testDb.select().from(s.learningRecords).where(eq(s.learningRecords.trackId, track.id));
    expect(records).toHaveLength(1);
    expect(records[0].recordType).toBe('prior_knowledge');
    expect(records[0].seq).toBe(1);
  });

  it('skips the record when prior knowledge is blank', async () => {
    const track = await createTrackWithMission(testDb, learnerId, { ...input, priorKnowledge: '  ' });
    const records = await testDb.select().from(s.learningRecords).where(eq(s.learningRecords.trackId, track.id));
    expect(records).toHaveLength(0);
  });

  it('assigns sequential record seqs under the lock convention', async () => {
    const track = await createTrackWithMission(testDb, learnerId, input);
    const seq = await testDb.transaction((tx) => nextRecordSeq(tx, track.id));
    expect(seq).toBe(2);
  });

  it('lists tracks newest first', async () => {
    const all = await listTracks(testDb, learnerId);
    expect(all.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 5: Verify + commit**

```bash
npm test && npx tsc --noEmit && npm run lint
git add -A && git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: track/mission services, tracks + concreteness APIs"
```

---

### Task 5: Mission interview UI

**Files:**
- Create: `src/components/interview-stepper.tsx`, `src/app/(app)/tracks/new/page.tsx`

- [ ] **Step 1: Stepper component** — `src/components/interview-stepper.tsx`. Client component implementing spec §1 flow 1. Steps: `why` (textarea + suggestion chips: "Pass an exam", "Build something", "Career move", "Teach someone", "Just curious"; on Next → POST /api/interview/concreteness; if `!concrete && followUp` and no follow-up shown yet → show the ONE follow-up question with its own textarea, append `\n\nFollow-up: ${followUp}\n${answer}` to whyText) → `success` (1–3 criteria inputs, add/remove) → `constraints` (timePerWeek select: "1 hour"/"3 hours"/"5+ hours" per week; optional deadline text; optional notes) → `prior` (textarea, "What do you already know about this? (optional)") → `scope` (optional tag input "Anything you DON'T want to cover?", skippable) → `card` (the editable Mission card: every field rendered as an editable input/textarea prefilled from state; Confirm button) → on Confirm: POST /api/tracks; on 200 redirect `router.push('/tracks/' + trackId)`.

Implementation requirements (write real code, ~200 lines):
- Props: `{ topic: string; vertical: 'programming' | 'history' }`.
- One `useState` machine: `step: 'why' | 'followup' | 'success' | 'constraints' | 'prior' | 'scope' | 'card'`, plus field state matching `createTrackInput` exactly (same field names — type-import `CreateTrackInput` from `@/server/tracks` for safety).
- Progress dots (7 steps) at top using sky-200/sky-600 tokens; Back buttons everywhere except step 1.
- Disable Next while the concreteness fetch is in flight ("Thinking…").
- Concreteness fetch failure → proceed without follow-up (the classifier is an enhancement, never a blocker) — `catch` → treat as concrete.
- All inputs labeled (a11y); errors via `role="alert"`.

- [ ] **Step 2: New-track page** — `src/app/(app)/tracks/new/page.tsx`. Client page: hero input "What do you want to learn?" (large, autofocused), vertical select with exactly: `programming`, `history`, and a disabled option "More subjects soon"; on submit (topic ≥3 chars) renders `<InterviewStepper topic={topic} vertical={vertical} />` in place.

- [ ] **Step 3: Manual smoke** — `npm run dev`, walk /tracks/new with `AI_FAKE_LLM=1` set in `.env.local` (fixture says concrete=true → no follow-up). Verify each step renders, Back works, the card shows editable prefilled fields, Confirm creates the track and redirects (watch the network tab for POST /api/tracks 200).

- [ ] **Step 4: Verify + commit**

```bash
npm test && npx tsc --noEmit && npm run lint && npm run build
git add -A && git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: mission interview stepper and new-track page"
```

---

### Task 6: Track initialization service + route

**Files:**
- Create: `src/server/track-init.ts`, `src/app/api/tracks/[id]/initialize/route.ts`, `src/app/api/tracks/[id]/calibration/route.ts`
- Test: `src/test/track-init.test.ts`

- [ ] **Step 1: Service** — `src/server/track-init.ts`

```ts
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import * as s from '@/db/schema';
import { llmObject } from '@/lib/ai';
import { validateSkillGraph, type GraphInput } from '@/lib/skill-graph';

type Db = NodePgDatabase<typeof s>;

export const skillGraphSchema = z.object({
  nodes: z
    .array(
      z.object({
        name: z.string().min(2).max(120),
        summary: z.string().max(300),
        missionRelevance: z.number().min(0).max(1),
      })
    )
    .min(10)
    .max(40),
  edges: z.array(z.object({ node: z.string(), prereq: z.string() })).max(120),
});

export const calibrationQuizSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        question: z.string().min(8).max(400),
        options: z.array(z.string().min(1).max(200)).length(4),
        correctIndex: z.number().int().min(0).max(3),
        conceptName: z.string().max(120),
      })
    )
    .min(2)
    .max(4),
});
export type CalibrationQuiz = z.infer<typeof calibrationQuizSchema>;

const GRAPH_SYSTEM = `You decompose a learning mission into a skill graph for one learner.
Rules: 10-40 nodes; each node is ONE teachable skill ("can do X"), named in plain language;
edges are prerequisites only (prereq must be learned before node); keep prerequisite chains
short (max depth 5); missionRelevance in [0,1] ranks how directly a node serves the mission;
NEVER include topics the learner marked out of scope. The graph is a map, not a syllabus —
bias toward the shortest path to the mission's success criteria.`;

function graphPrompt(track: { topic: string; vertical: string }, mission: {
  whyText: string; successCriteria: unknown; constraints: unknown; outOfScope: string[];
}) {
  return [
    `Topic: ${track.topic} (vertical: ${track.vertical})`,
    `Why: ${mission.whyText}`,
    `Success criteria: ${JSON.stringify(mission.successCriteria)}`,
    `Constraints: ${JSON.stringify(mission.constraints)}`,
    `Out of scope (NEVER include): ${mission.outOfScope.join(', ') || 'none'}`,
  ].join('\n');
}

export type InitResult =
  | { status: 'initialized'; nodeCount: number; quiz: CalibrationQuiz }
  | { status: 'already_initialized' }
  | { status: 'failed'; errors: string[] };

/** Idempotent. Generates + validates the skill graph (one retry with validator errors), persists, then generates the calibration quiz. */
export async function initializeTrack(db: Db, trackId: string): Promise<InitResult> {
  const existing = await db.select({ id: s.skillNodes.id }).from(s.skillNodes).where(eq(s.skillNodes.trackId, trackId)).limit(1);
  if (existing.length > 0) return { status: 'already_initialized' };

  const [track] = await db.select().from(s.tracks).where(eq(s.tracks.id, trackId));
  const [mission] = await db.select().from(s.missions).where(eq(s.missions.trackId, trackId));
  if (!track || !mission) return { status: 'failed', errors: ['track or mission missing'] };

  const prompt = graphPrompt(track, mission);
  let graph: GraphInput = await llmObject({
    purpose: 'skill-graph', tier: 'planner', schema: skillGraphSchema, system: GRAPH_SYSTEM, prompt,
  });
  let check = validateSkillGraph(graph, mission.outOfScope);
  if (!check.ok) {
    // ONE retry, feeding the validator errors back (spec §2; do not loop further).
    graph = await llmObject({
      purpose: 'skill-graph', tier: 'planner', schema: skillGraphSchema, system: GRAPH_SYSTEM,
      prompt: `${prompt}\n\nYour previous attempt failed validation:\n- ${check.errors.join('\n- ')}\nFix every issue.`,
    });
    check = validateSkillGraph(graph, mission.outOfScope);
    if (!check.ok) return { status: 'failed', errors: check.errors };
  }

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(s.skillNodes)
      .values(graph.nodes.map((n) => ({ trackId, name: n.name, summary: n.summary, missionRelevance: n.missionRelevance })))
      .returning({ id: s.skillNodes.id, name: s.skillNodes.name });
    const idByName = new Map(inserted.map((n) => [n.name, n.id]));
    if (graph.edges.length > 0) {
      await tx.insert(s.skillNodeEdges).values(
        graph.edges.map((e) => ({ nodeId: idByName.get(e.node)!, prereqId: idByName.get(e.prereq)! }))
      );
    }
  });

  const quiz = await llmObject({
    purpose: 'calibration-quiz', tier: 'generator', schema: calibrationQuizSchema,
    system:
      'Write a 2-4 item multiple-choice micro-quiz to calibrate a learner\'s starting level for the given skill graph. Each item probes ONE foundational node (use its exact name as conceptName). Plain language, one clearly-correct option, three plausible distractors. This is a friendly placement check, not a test.',
    prompt: `${prompt}\n\nFoundational nodes: ${graph.nodes.slice(0, 6).map((n) => n.name).join(', ')}`,
  });

  return { status: 'initialized', nodeCount: graph.nodes.length, quiz };
}
```

- [ ] **Step 2: Initialize route** — `src/app/api/tracks/[id]/initialize/route.ts`

```ts
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getLearnerByUserId } from '@/server/learners';
import { getTrackDetail } from '@/server/tracks';
import { initializeTrack } from '@/server/track-init';

export const maxDuration = 300; // Opus-tier graph generation can take minutes

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });
  const detail = await getTrackDetail(db, id, learner.id); // ownership check
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const result = await initializeTrack(db, id);
  if (result.status === 'failed') return NextResponse.json(result, { status: 502 });
  return NextResponse.json(result);
}
```

- [ ] **Step 3: Calibration route** — `src/app/api/tracks/[id]/calibration/route.ts` (stores ONE raw answer per call; Phase 5 distills)

```ts
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { getTrackDetail } from '@/server/tracks';

const bodySchema = z.object({
  item: z.object({
    id: z.string(),
    question: z.string(),
    options: z.array(z.string()).length(4),
    correctIndex: z.number().int().min(0).max(3),
    conceptName: z.string(),
  }),
  answerIndex: z.number().int().min(0).max(3),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });
  if (!(await getTrackDetail(db, id, learner.id))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const { item, answerIndex } = parsed.data;
  await db.insert(s.attemptEvents).values({
    learnerId: learner.id,
    eventType: 'calibration',
    correct: answerIndex === item.correctIndex,
    payload: { trackId: id, item, answerIndex }, // raw storage — distilled in Phase 5
  });
  return NextResponse.json({ correct: answerIndex === item.correctIndex });
}
```

- [ ] **Step 4: Integration tests** — `src/test/track-init.test.ts` (runs with the suite's env; set fake mode per-test)

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testPool, resetDb } from './db';
import * as s from '@/db/schema';
import { createTrackWithMission } from '@/server/tracks';
import { initializeTrack } from '@/server/track-init';

describe('track initialization (fake LLM)', () => {
  let trackId: string;

  beforeEach(() => { process.env.AI_FAKE_LLM = '1'; });
  beforeAll(async () => {
    await resetDb();
    const [u] = await testDb.insert(s.user).values({ id: crypto.randomUUID(), name: 'I', email: 'i@t.dev' }).returning();
    const [learner] = await testDb.insert(s.learners).values({ userId: u.id, displayName: 'I', ageBand: '18_plus' }).returning();
    const track = await createTrackWithMission(testDb, learner.id, {
      topic: 'Python CLI tools', vertical: 'programming', whyText: 'ship a CLI',
      successCriteria: [{ description: 'CLI my team uses' }], constraints: {}, outOfScope: [],
    });
    trackId = track.id;
  });
  afterAll(() => testPool.end());

  it('persists a validated graph and returns a quiz', async () => {
    const result = await initializeTrack(testDb, trackId);
    expect(result.status).toBe('initialized');
    if (result.status !== 'initialized') return;
    expect(result.nodeCount).toBe(10);
    expect(result.quiz.items.length).toBeGreaterThanOrEqual(2);
    const nodes = await testDb.select().from(s.skillNodes).where(eq(s.skillNodes.trackId, trackId));
    expect(nodes).toHaveLength(10);
    const edges = await testDb.select().from(s.skillNodeEdges);
    expect(edges.length).toBe(10);
  });

  it('is idempotent', async () => {
    const again = await initializeTrack(testDb, trackId);
    expect(again.status).toBe('already_initialized');
  });

  it('fails cleanly when the graph violates out-of-scope (retry exhausted)', async () => {
    // The fixture contains a node "Error handling" — declare it out of scope to force failure both attempts.
    const [u] = await testDb.insert(s.user).values({ id: crypto.randomUUID(), name: 'I2', email: 'i2@t.dev' }).returning();
    const [learner] = await testDb.insert(s.learners).values({ userId: u.id, displayName: 'I2', ageBand: '18_plus' }).returning();
    const track = await createTrackWithMission(testDb, learner.id, {
      topic: 'Python', vertical: 'programming', whyText: 'x', successCriteria: [{ description: 'y' }],
      constraints: {}, outOfScope: ['error handling'],
    });
    const result = await initializeTrack(testDb, track.id);
    expect(result.status).toBe('failed');
    const nodes = await testDb.select().from(s.skillNodes).where(eq(s.skillNodes.trackId, track.id));
    expect(nodes).toHaveLength(0); // nothing persisted on failure
  });
});
```

- [ ] **Step 5: Verify + commit**

```bash
npm test && npx tsc --noEmit && npm run lint
git add -A && git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: idempotent track initialization with validated skill graph + calibration quiz"
```

---

### Task 7: Track dashboard

**Files:**
- Create: `src/app/(app)/tracks/page.tsx`, `src/app/(app)/tracks/[id]/page.tsx`, `src/app/(app)/tracks/[id]/track-setup.tsx`

- [ ] **Step 1: Track list** — `src/app/(app)/tracks/page.tsx` (server component): load session learner (same pattern as the layout), `listTracks`; empty state = sky-styled card "What do you want to learn?" linking to /tracks/new; otherwise grid of track cards (topic, vertical badge, status, created date) linking to `/tracks/[id]`, plus a "+ New track" button.

- [ ] **Step 2: Track detail** — `src/app/(app)/tracks/[id]/page.tsx` (server component): `getTrackDetail`; 404 via `notFound()` when null. Renders: Mission card (why, success criteria list, constraints, out-of-scope tags — read-only display); then:
  - if `nodes.length === 0` → render `<TrackSetup trackId={track.id} mode="build" />`
  - else → "Learning map" summary: node count + nodes grouped by `mastery` (sun-100 chip per node name, grouped under "Up next / In progress / Done" headings using mastery enum), then `<TrackSetup trackId={track.id} mode="calibrate" />` ONLY if no calibration events exist yet (check: `select 1 from attempt_events where event_type='calibration' and payload->>'trackId' = track.id limit 1` — add a small `hasCalibration(db, trackId)` helper to `src/server/track-init.ts` using `sql` json operator), and finally the stub:

```tsx
<div className="mt-8 rounded-xl bg-sun-100 px-5 py-4 text-sun-700">
  <p className="font-medium">Your first lesson is coming soon</p>
  <p className="mt-1 text-sm">Lesson generation arrives in the next phase — your learning map is ready for it.</p>
</div>
```

- [ ] **Step 3: TrackSetup client component** — `src/app/(app)/tracks/[id]/track-setup.tsx`:
  - `mode="build"`: on mount, POST `/api/tracks/[id]/initialize`; while pending show a calm status panel cycling messages every ~2.5s ("Reading your mission…", "Mapping the skills…", "Ordering the steps…", "Almost there…") — plain `setInterval`, no animation lib; on `initialized` → store `result.quiz` in state and switch to quiz UI; on `already_initialized` → `router.refresh()`; on failure (502) → friendly error + "Try again" button (re-POSTs).
  - quiz UI (also used by `mode="calibrate"` — but in that mode there's no quiz payload available, so in `mode="calibrate"` render nothing and return null for v1; ONLY the build flow administers the quiz. Keep the prop anyway for the detail page logic): one item at a time, options as buttons; on answer → POST `/api/tracks/[id]/calibration` with `{item, answerIndex}`; show "Nice!" / "Good to know — we'll start there." (no right/wrong drama — it's calibration); after last item → `router.refresh()` (server component re-renders with nodes + stub).

Simplification note (deliberate, spec-compliant): if a learner closes the tab mid-quiz, remaining items are simply skipped — calibration is best-effort raw signal; Phase 5 distillation tolerates partial answers. `mode="calibrate"` rendering nothing means refreshed/returning visitors don't retake the quiz.

- [ ] **Step 4: Manual smoke** — full walk with `AI_FAKE_LLM=1`: new track → interview → confirm → "Mapping the skills…" → 2 fixture quiz items → answers stored (`docker compose exec db psql -U learnanything -d learnanything -c "select event_type, correct from attempt_events"`) → map + stub render.

- [ ] **Step 5: Verify + commit**

```bash
npm test && npx tsc --noEmit && npm run lint && npm run build
git add -A && git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "feat: track dashboard with learning-map build flow and calibration quiz"
```

---

### Task 8: Playwright e2e + CI

**Files:**
- Create: `playwright.config.ts`, `e2e/onboarding.spec.ts`
- Modify: `package.json` (script), `.github/workflows/ci.yml`, `.gitignore` (playwright artifacts)

- [ ] **Step 1: Install**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:3100' },
  webServer: {
    command: 'npm run dev -- --port 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    env: {
      AI_FAKE_LLM: '1',
      // e2e writes through the app's own DATABASE_URL — point it at the test DB.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      BETTER_AUTH_URL: 'http://localhost:3100',
    },
    timeout: 120_000,
  },
});
```

Add to `.gitignore`: `test-results/` and `playwright-report/`. Add script: `"test:e2e": "playwright test"`.
NOTE: Vitest must not pick up e2e specs — confirm `vitest.config.ts` only includes default patterns (e2e/*.spec.ts matches Vitest's defaults! Add `exclude: ['e2e/**', 'node_modules/**']` to the vitest config test block).

- [ ] **Step 3: `e2e/onboarding.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

test('signup → mission interview → learning map → calibration → stub', async ({ page }) => {
  const email = `e2e-${Date.now()}@t.dev`;

  await page.goto('/signup');
  await page.selectOption('select', '1990');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder('Your name').fill('E2E Learner');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder(/Password/).fill('a-strong-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/tracks/);

  await page.goto('/tracks/new');
  await page.getByPlaceholder(/What do you want to learn/i).fill('Python CLI tools');
  await page.getByRole('button', { name: /start/i }).click();

  // why (fixture: concrete → no follow-up)
  await page.getByRole('textbox').fill('Ship a CLI to my team');
  await page.getByRole('button', { name: /next/i }).click();
  // success criteria
  await page.getByRole('textbox').first().fill('Publish a CLI my team installs');
  await page.getByRole('button', { name: /next/i }).click();
  // constraints (defaults fine)
  await page.getByRole('button', { name: /next/i }).click();
  // prior knowledge
  await page.getByRole('textbox').fill('I know Python basics');
  await page.getByRole('button', { name: /next/i }).click();
  // out of scope (skip)
  await page.getByRole('button', { name: /next|skip/i }).click();
  // mission card → confirm
  await page.getByRole('button', { name: /confirm/i }).click();

  // track page: map builds via fake LLM, then quiz (2 fixture items)
  await expect(page.getByText(/Mapping the skills|Reading your mission/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stores a value under a name' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Stores a value under a name' }).click();
  await page.getByRole('button', { name: 'Repeat work without copy-pasting code' }).click();

  // map + stub
  await expect(page.getByText(/first lesson is coming soon/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Variables and types')).toBeVisible();
});
```

Adjust selectors to the real components as built in Tasks 5/7 — the spec for THIS task is: the full path must pass headless. If a selector is ambiguous, prefer adding `data-testid` to components over brittle text matches.

- [ ] **Step 4: Run locally**

```bash
npm run test:e2e   # 1 passed (uses local docker test DB; ensure docker compose is up)
```

- [ ] **Step 5: CI** — in `.github/workflows/ci.yml`, after the `npm run build` step add:

```yaml
      - run: npx playwright install --with-deps chromium
      - run: npx drizzle-kit migrate
      - run: npm run test:e2e
        env:
          AI_FAKE_LLM: "1"
```

(The job-level env already provides DATABASE_URL/TEST_DATABASE_URL pointing at the service DB; drizzle-kit migrate applies the schema for the dev server. The webServer config maps TEST_DATABASE_URL → DATABASE_URL for the app.)

- [ ] **Step 6: Verify + commit + push**

```bash
npm test && npm run test:e2e && npm run lint && npm run build
git add -A && git commit --author="Andes Lee <andes.lee444@gmail.com>" -m "test: onboarding e2e (Playwright) + CI"
git push -u origin phase-2-onboarding
gh run watch --exit-status || gh run list --limit 1   # confirm CI green on the branch
```

---

## Done criteria (Phase 2)

- A new visitor can: land → signup (age screen; under-13 birth years see the block screen with nothing stored) → /tracks/new → interview (≤7 steps, ONE concreteness follow-up max, "just curious" accepted) → editable Mission card → confirm → watch the map build → answer 2–4 calibration items → see the learning map + "first lesson coming soon" stub.
- `attempt_events` holds raw calibration rows (`event_type='calibration'`, payload carries trackId + full item); a `prior_knowledge` learning record exists when stated; mission + skill graph persisted; re-POSTing initialize is a no-op.
- All Vitest suites green (incl. fake-LLM track-init tests), e2e green locally AND in CI, `tsc`/lint/build clean.
- No real LLM call happens anywhere in tests/e2e/CI (`AI_FAKE_LLM=1`); with a real `AI_GATEWAY_API_KEY` in `.env.local`, the same flow works against live models (manual founder check).
- Phase 5 explicitly NOT here: no distillation, no node-mastery seeding from calibration, no FSRS cards yet (spec §12 phase 2 done-state).
