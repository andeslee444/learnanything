'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
// Type-only import: CreateTrackInput is a plain Zod-inferred type (no runtime server code).
// If this import ever drags in server-only deps, duplicate the type here with a `satisfies` check.
import type { CreateTrackInput } from '@/server/tracks';

type Step = 'why' | 'followup' | 'success' | 'constraints' | 'prior' | 'scope' | 'card';

const STEPS: Step[] = ['why', 'followup', 'success', 'constraints', 'prior', 'scope', 'card'];
const STEP_LABELS: Record<Step, string> = {
  why: 'Why',
  followup: 'Tell us more',
  success: 'Success',
  constraints: 'Constraints',
  prior: 'Prior knowledge',
  scope: 'Out of scope',
  card: 'Mission card',
};

const WHY_CHIPS = ['Pass an exam', 'Build something', 'Career move', 'Teach someone', 'Just curious'];

// ── Shared UI pieces (outside component to satisfy react-hooks/static-components) ──

function ProgressDots({ stepIndex }: { stepIndex: number }) {
  return (
    <div className="mb-8 flex justify-center gap-2" aria-label="Step progress">
      {STEPS.map((s, i) => (
        <span
          key={s}
          className={`h-2 w-2 rounded-full ${i === stepIndex ? 'bg-sky-600' : 'bg-sky-200'}`}
          aria-label={`Step ${i + 1}: ${STEP_LABELS[s]}${i === stepIndex ? ' (current)' : ''}`}
        />
      ))}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      data-testid="interview-back"
      onClick={onBack}
      className="mb-4 text-sm text-ink-600 hover:text-ink-900"
    >
      ← Back
    </button>
  );
}

// ── Main stepper component ────────────────────────────────────

interface Props {
  topic: string;
  vertical: 'programming' | 'history';
}

export function InterviewStepper({ topic, vertical }: Props) {
  const router = useRouter();

  // ── step machine ────────────────────────────────────────────
  const [step, setStep] = useState<Step>('why');
  const [followUpQuestion, setFollowUpQuestion] = useState<string | null>(null);
  const [followUpShown, setFollowUpShown] = useState(false);

  // ── field state — names mirror CreateTrackInput exactly ─────
  const [whyText, setWhyText] = useState('');
  const [followUpAnswer, setFollowUpAnswer] = useState('');
  const [successCriteria, setSuccessCriteria] = useState<string[]>(['']);
  const [timePerWeek, setTimePerWeek] = useState('');
  const [deadline, setDeadline] = useState('');
  const [notes, setNotes] = useState('');
  const [priorKnowledge, setPriorKnowledge] = useState('');
  const [scopeInput, setScopeInput] = useState('');
  const [outOfScope, setOutOfScope] = useState<string[]>([]);

  // ── card-edit mirrors (editable overrides on Mission card) ───
  const [cardWhy, setCardWhy] = useState('');
  const [cardCriteria, setCardCriteria] = useState<string[]>([]);
  const [cardTimePerWeek, setCardTimePerWeek] = useState('');
  const [cardDeadline, setCardDeadline] = useState('');
  const [cardNotes, setCardNotes] = useState('');
  const [cardPrior, setCardPrior] = useState('');
  const [cardScope, setCardScope] = useState<string[]>([]);
  const [cardScopeInput, setCardScopeInput] = useState('');

  // ── async state ──────────────────────────────────────────────
  const [thinking, setThinking] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── computed effective why (with follow-up appended) ─────────
  function effectiveWhy(): string {
    if (followUpQuestion && followUpAnswer.trim()) {
      return `${whyText}\n\nFollow-up: ${followUpQuestion}\n${followUpAnswer.trim()}`;
    }
    return whyText;
  }

  // ── progress ─────────────────────────────────────────────────
  const stepIndex = STEPS.indexOf(step);

  // ── step helpers ─────────────────────────────────────────────
  function goBack() {
    if (step === 'followup') { setStep('why'); return; }
    if (step === 'success') { setStep(followUpShown ? 'followup' : 'why'); return; }
    if (step === 'constraints') { setStep('success'); return; }
    if (step === 'prior') { setStep('constraints'); return; }
    if (step === 'scope') { setStep('prior'); return; }
    if (step === 'card') { setStep('scope'); return; }
  }

  // ── why: Next handler with concreteness check ────────────────
  async function handleWhyNext() {
    if (!whyText.trim() || thinking || submitBusy) return;
    setThinking(true);
    try {
      const res = await fetch('/api/interview/concreteness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, why: whyText }),
      });
      if (res.ok) {
        const data: { concrete: boolean; followUp: string | null } = await res.json();
        // If classifier says not concrete AND provides a follow-up question AND we haven't shown one yet
        if (!data.concrete && data.followUp && !followUpShown) {
          setFollowUpQuestion(data.followUp);
          setFollowUpShown(true);
          setStep('followup');
          return;
        }
      }
      // 429, non-ok, or concrete → proceed as concrete (classifier is enhancement-only)
    } catch {
      // fetch failure → proceed as concrete (classifier is enhancement-only)
    } finally {
      setThinking(false);
    }
    setStep('success');
  }

  // ── success criteria ─────────────────────────────────────────
  function addCriterion() {
    if (successCriteria.length < 3) setSuccessCriteria([...successCriteria, '']);
  }
  function removeCriterion(i: number) {
    if (successCriteria.length <= 1) return;
    setSuccessCriteria(successCriteria.filter((_, idx) => idx !== i));
  }
  function updateCriterion(i: number, val: string) {
    const next = [...successCriteria];
    next[i] = val;
    setSuccessCriteria(next);
  }

  // ── scope tag input ───────────────────────────────────────────
  function handleScopeKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = scopeInput.trim();
      if (val.length >= 2 && !outOfScope.includes(val)) {
        setOutOfScope([...outOfScope, val]);
      }
      setScopeInput('');
    }
  }
  function removeScope(tag: string) {
    setOutOfScope(outOfScope.filter((t) => t !== tag));
  }

  // ── open card: sync card state from interview state ───────────
  function openCard() {
    setCardWhy(effectiveWhy());
    setCardCriteria([...successCriteria]);
    setCardTimePerWeek(timePerWeek);
    setCardDeadline(deadline);
    setCardNotes(notes);
    setCardPrior(priorKnowledge);
    setCardScope([...outOfScope]);
    setStep('card');
  }

  // ── confirm: POST /api/tracks ─────────────────────────────────
  async function handleConfirm() {
    if (submitBusy) return;
    setSubmitBusy(true);
    setSubmitError(null);

    const filteredCriteria = cardCriteria.filter((c) => c.trim().length >= 3);
    if (filteredCriteria.length === 0) {
      setSubmitError('Add at least one success criterion of a few words.');
      setSubmitBusy(false);
      return;
    }

    const payload: CreateTrackInput = {
      topic,
      vertical,
      whyText: cardWhy || effectiveWhy(),
      successCriteria: filteredCriteria.map((c) => ({ description: c.trim() })),
      constraints: {
        timePerWeek: cardTimePerWeek || undefined,
        deadline: cardDeadline || undefined,
        notes: cardNotes || undefined,
      },
      priorKnowledge: cardPrior || undefined,
      outOfScope: cardScope.filter((t) => t.length >= 2),
    };

    try {
      const res = await fetch('/api/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSubmitError((body as { error?: string }).error ?? `Error ${res.status} — please try again.`);
        return;
      }
      const { trackId } = (await res.json()) as { trackId: string };
      router.push(`/tracks/${trackId}`);
    } catch {
      setSubmitError('Network error — please check your connection and try again.');
    } finally {
      setSubmitBusy(false);
    }
  }

  // ── step: why ─────────────────────────────────────────────────
  if (step === 'why') {
    return (
      <div className="mx-auto w-full max-w-xl py-8">
        <ProgressDots stepIndex={stepIndex} />
        <h2 className="text-2xl font-medium text-ink-900">Why do you want to learn this?</h2>
        <p className="mt-2 text-sm text-ink-600">
          Be as specific as you like — it helps us build a mission around your real goal.
        </p>
        <textarea
          data-testid="why-input"
          aria-label="Why you want to learn this topic"
          className="mt-6 w-full rounded-md border border-ink-400/40 bg-white p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
          rows={4}
          placeholder="e.g. I want to build a CLI tool to share with my team"
          value={whyText}
          onChange={(e) => setWhyText(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {WHY_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => {
                // Clicking a chip appends/sets text in the textarea
                if (whyText.trim()) {
                  setWhyText(whyText.trimEnd() + ' ' + chip.toLowerCase());
                } else {
                  setWhyText(chip);
                }
              }}
              className="rounded-md bg-sky-100 px-3 py-1 text-sm font-medium text-sky-700 hover:bg-sky-200"
            >
              {chip}
            </button>
          ))}
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            data-testid="interview-next"
            disabled={!whyText.trim() || thinking}
            onClick={handleWhyNext}
            className="rounded-md bg-sky-600 px-6 py-2 font-medium text-white disabled:opacity-50"
          >
            {thinking ? 'Thinking…' : 'Next'}
          </button>
        </div>
      </div>
    );
  }

  // ── step: followup ────────────────────────────────────────────
  if (step === 'followup') {
    return (
      <div className="mx-auto w-full max-w-xl py-8">
        <ProgressDots stepIndex={stepIndex} />
        <BackButton onBack={goBack} />
        <h2 className="text-2xl font-medium text-ink-900">One quick question</h2>
        {/* Render the LLM-generated follow-up question as plain text only — never use dangerouslySetInnerHTML */}
        <p className="mt-4 text-ink-900">{followUpQuestion}</p>
        <textarea
          aria-label="Your answer to the follow-up question"
          className="mt-4 w-full rounded-md border border-ink-400/40 bg-white p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
          rows={3}
          placeholder="Your answer…"
          value={followUpAnswer}
          onChange={(e) => setFollowUpAnswer(e.target.value)}
        />
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            data-testid="interview-next"
            onClick={() => setStep('success')}
            className="rounded-md bg-sky-600 px-6 py-2 font-medium text-white"
          >
            Next
          </button>
        </div>
      </div>
    );
  }

  // ── step: success ─────────────────────────────────────────────
  if (step === 'success') {
    const canAddMore = successCriteria.length < 3;
    return (
      <div className="mx-auto w-full max-w-xl py-8">
        <ProgressDots stepIndex={stepIndex} />
        <BackButton onBack={goBack} />
        <h2 className="text-2xl font-medium text-ink-900">What does success look like?</h2>
        <p className="mt-2 text-sm text-ink-600">
          1–3 concrete outcomes. How will you know you&apos;ve learned what you set out to?
        </p>
        <div className="mt-6 space-y-3">
          {successCriteria.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                data-testid={`criterion-input-${i}`}
                aria-label={`Success criterion ${i + 1}`}
                className="flex-1 rounded-md border border-ink-400/40 bg-white p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
                placeholder={`Criterion ${i + 1}`}
                value={c}
                onChange={(e) => updateCriterion(i, e.target.value)}
              />
              {successCriteria.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove criterion ${i + 1}`}
                  onClick={() => removeCriterion(i)}
                  className="rounded-md px-2 py-2 text-ink-400 hover:text-ink-900"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        {canAddMore && (
          <button
            type="button"
            onClick={addCriterion}
            className="mt-3 text-sm text-sky-600 hover:underline"
          >
            + Add another
          </button>
        )}
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            data-testid="interview-next"
            disabled={!successCriteria.some((c) => c.trim().length >= 3)}
            onClick={() => setStep('constraints')}
            className="rounded-md bg-sky-600 px-6 py-2 font-medium text-white disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    );
  }

  // ── step: constraints ─────────────────────────────────────────
  if (step === 'constraints') {
    return (
      <div className="mx-auto w-full max-w-xl py-8">
        <ProgressDots stepIndex={stepIndex} />
        <BackButton onBack={goBack} />
        <h2 className="text-2xl font-medium text-ink-900">Any constraints on your time?</h2>
        <p className="mt-2 text-sm text-ink-600">Optional — helps us pace the learning map.</p>
        <div className="mt-6 space-y-4">
          <div>
            <label htmlFor="time-per-week" className="mb-1 block text-sm font-medium text-ink-900">
              Time per week
            </label>
            <select
              id="time-per-week"
              aria-label="Time available per week"
              className="w-full rounded-md border border-ink-400/40 bg-white p-3 text-ink-900 focus:outline-none focus:ring-2 focus:ring-sky-400"
              value={timePerWeek}
              onChange={(e) => setTimePerWeek(e.target.value)}
            >
              <option value="">No preference</option>
              <option value="1 hour">1 hour per week</option>
              <option value="3 hours">3 hours per week</option>
              <option value="5+ hours">5+ hours per week</option>
            </select>
          </div>
          <div>
            <label htmlFor="deadline" className="mb-1 block text-sm font-medium text-ink-900">
              Deadline <span className="font-normal text-ink-400">(optional)</span>
            </label>
            <input
              id="deadline"
              aria-label="Deadline"
              className="w-full rounded-md border border-ink-400/40 bg-white p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
              placeholder="e.g. Before June 2027"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="notes" className="mb-1 block text-sm font-medium text-ink-900">
              Other notes <span className="font-normal text-ink-400">(optional)</span>
            </label>
            <input
              id="notes"
              aria-label="Additional notes"
              className="w-full rounded-md border border-ink-400/40 bg-white p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
              placeholder="Anything else we should know?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            data-testid="interview-next"
            onClick={() => setStep('prior')}
            className="rounded-md bg-sky-600 px-6 py-2 font-medium text-white"
          >
            Next
          </button>
        </div>
      </div>
    );
  }

  // ── step: prior ───────────────────────────────────────────────
  if (step === 'prior') {
    return (
      <div className="mx-auto w-full max-w-xl py-8">
        <ProgressDots stepIndex={stepIndex} />
        <BackButton onBack={goBack} />
        <h2 className="text-2xl font-medium text-ink-900">What do you already know?</h2>
        <p className="mt-2 text-sm text-ink-600">Optional — skip if you&apos;re starting from scratch.</p>
        <textarea
          data-testid="prior-input"
          aria-label="What you already know about this topic"
          className="mt-6 w-full rounded-md border border-ink-400/40 bg-white p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
          rows={4}
          placeholder="e.g. I know the basics of Python — variables, loops, functions"
          value={priorKnowledge}
          onChange={(e) => setPriorKnowledge(e.target.value)}
        />
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            data-testid="interview-next"
            onClick={() => setStep('scope')}
            className="rounded-md bg-sky-600 px-6 py-2 font-medium text-white"
          >
            Next
          </button>
        </div>
      </div>
    );
  }

  // ── step: scope ───────────────────────────────────────────────
  if (step === 'scope') {
    return (
      <div className="mx-auto w-full max-w-xl py-8">
        <ProgressDots stepIndex={stepIndex} />
        <BackButton onBack={goBack} />
        <h2 className="text-2xl font-medium text-ink-900">Anything you don&apos;t want to cover?</h2>
        <p className="mt-2 text-sm text-ink-600">
          Optional — type a topic and press Enter. Click a tag to remove it.
        </p>
        <input
          data-testid="scope-input"
          aria-label="Topics to exclude — type and press Enter to add"
          className="mt-6 w-full rounded-md border border-ink-400/40 bg-white p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
          placeholder="e.g. async programming"
          value={scopeInput}
          onChange={(e) => setScopeInput(e.target.value)}
          onKeyDown={handleScopeKeyDown}
        />
        {outOfScope.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {outOfScope.map((tag) => (
              <button
                key={tag}
                type="button"
                aria-label={`Remove "${tag}" from out-of-scope`}
                onClick={() => removeScope(tag)}
                className="flex items-center gap-1 rounded-md bg-ink-400/10 px-3 py-1 text-sm text-ink-900 hover:bg-ink-400/20"
              >
                {tag} <span aria-hidden="true">✕</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            data-testid="interview-next"
            onClick={openCard}
            className="rounded-md bg-sky-600 px-6 py-2 font-medium text-white"
          >
            {outOfScope.length === 0 ? 'Skip' : 'Next'}
          </button>
        </div>
      </div>
    );
  }

  // ── step: card ────────────────────────────────────────────────
  if (step === 'card') {
    return (
      <div className="mx-auto w-full max-w-xl py-8">
        <ProgressDots stepIndex={stepIndex} />
        <BackButton onBack={goBack} />
        <h2 className="text-2xl font-medium text-ink-900">Your Mission Card</h2>
        <p className="mt-2 text-sm text-ink-600">
          Everything&apos;s editable. Make it feel right before confirming.
        </p>
        <div className="mt-6 space-y-5 rounded-xl border border-ink-400/20 bg-white p-6">
          {/* Topic (read-only — set before the stepper) */}
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-400">Topic</p>
            <p className="text-ink-900">{topic}</p>
          </div>

          {/* Why */}
          <div>
            <label htmlFor="card-why" className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">
              Why
            </label>
            <textarea
              id="card-why"
              aria-label="Your reason for learning"
              className="w-full rounded-md border border-ink-400/40 bg-cloud p-3 text-ink-900 focus:outline-none focus:ring-2 focus:ring-sky-400"
              rows={3}
              value={cardWhy}
              onChange={(e) => setCardWhy(e.target.value)}
            />
          </div>

          {/* Success criteria */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">Success criteria</p>
            <div className="space-y-2">
              {cardCriteria.map((c, i) => (
                <input
                  key={i}
                  data-testid={`criterion-input-${i}`}
                  aria-label={`Success criterion ${i + 1}`}
                  className="w-full rounded-md border border-ink-400/40 bg-cloud p-3 text-ink-900 focus:outline-none focus:ring-2 focus:ring-sky-400"
                  value={c}
                  onChange={(e) => {
                    const next = [...cardCriteria];
                    next[i] = e.target.value;
                    setCardCriteria(next);
                  }}
                />
              ))}
            </div>
          </div>

          {/* Constraints */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">Constraints</p>
            <div className="space-y-2">
              <input
                aria-label="Time per week"
                className="w-full rounded-md border border-ink-400/40 bg-cloud p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
                placeholder="Time per week"
                value={cardTimePerWeek}
                onChange={(e) => setCardTimePerWeek(e.target.value)}
              />
              <input
                aria-label="Deadline"
                className="w-full rounded-md border border-ink-400/40 bg-cloud p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
                placeholder="Deadline (optional)"
                value={cardDeadline}
                onChange={(e) => setCardDeadline(e.target.value)}
              />
              <input
                aria-label="Additional notes"
                className="w-full rounded-md border border-ink-400/40 bg-cloud p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
                placeholder="Notes (optional)"
                value={cardNotes}
                onChange={(e) => setCardNotes(e.target.value)}
              />
            </div>
          </div>

          {/* Prior knowledge */}
          <div>
            <label htmlFor="card-prior" className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">
              Prior knowledge
            </label>
            <textarea
              id="card-prior"
              data-testid="prior-input"
              aria-label="What you already know"
              className="w-full rounded-md border border-ink-400/40 bg-cloud p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
              rows={2}
              placeholder="What you already know (optional)"
              value={cardPrior}
              onChange={(e) => setCardPrior(e.target.value)}
            />
          </div>

          {/* Out of scope */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">Out of scope</p>
            {cardScope.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {cardScope.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    aria-label={`Remove ${tag}`}
                    onClick={() => setCardScope(cardScope.filter((t) => t !== tag))}
                    className="flex items-center gap-1 rounded-md bg-ink-400/10 px-3 py-1 text-sm text-ink-900 hover:bg-ink-400/20"
                  >
                    {tag} <span aria-hidden="true">✕</span>
                  </button>
                ))}
              </div>
            )}
            <input
              aria-label="Add out-of-scope topic"
              data-testid="card-scope-input"
              className="w-full rounded-md border border-ink-400/40 bg-cloud p-3 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
              placeholder="Type a topic and press Enter"
              value={cardScopeInput}
              onChange={(e) => setCardScopeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const val = cardScopeInput.trim();
                  if (val.length >= 2 && !cardScope.includes(val)) {
                    setCardScope([...cardScope, val]);
                  }
                  setCardScopeInput('');
                }
              }}
            />
          </div>
        </div>

        {submitError && (
          <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">
            {submitError}
          </p>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            data-testid="interview-confirm"
            disabled={submitBusy}
            onClick={handleConfirm}
            className="rounded-md bg-sky-600 px-8 py-3 font-medium text-white disabled:opacity-50"
          >
            {submitBusy ? 'Saving…' : 'Confirm mission'}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
