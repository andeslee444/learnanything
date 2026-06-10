'use client';

import { useState } from 'react';
import { InterviewStepper } from '@/components/interview-stepper';

type Vertical = 'programming' | 'history';

export default function NewTrackPage() {
  const [topic, setTopic] = useState('');
  const [vertical, setVertical] = useState<Vertical>('programming');
  const [started, setStarted] = useState(false);

  if (started && topic.trim().length >= 3) {
    return (
      <main className="px-6 py-8">
        <InterviewStepper topic={topic.trim()} vertical={vertical} />
      </main>
    );
  }

  function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (topic.trim().length >= 3) setStarted(true);
  }

  return (
    <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-6 py-12">
      <form onSubmit={handleStart} className="w-full max-w-xl">
        <h1 className="text-4xl font-medium tracking-tight text-ink-900">
          What do you want to learn?
        </h1>
        <p className="mt-3 text-ink-600">
          Be as specific as you like — we&apos;ll build a personal learning mission around your goal.
        </p>
        <input
          data-testid="topic-input"
          aria-label="Topic you want to learn"
          className="mt-8 w-full rounded-lg border border-ink-400/40 bg-white px-4 py-4 text-lg text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
          placeholder="e.g. Python CLI tools, the French Revolution…"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          autoFocus
        />
        <div className="mt-4">
          <label htmlFor="vertical-select" className="mb-2 block text-sm font-medium text-ink-900">
            Subject area
          </label>
          <select
            id="vertical-select"
            data-testid="vertical-select"
            aria-label="Subject area"
            className="w-full rounded-md border border-ink-400/40 bg-white px-4 py-3 text-ink-900 focus:outline-none focus:ring-2 focus:ring-sky-400"
            value={vertical}
            onChange={(e) => setVertical(e.target.value as Vertical)}
          >
            <option value="programming">Programming</option>
            <option value="history">History</option>
            <option disabled value="more">More subjects soon</option>
          </select>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="submit"
            data-testid="topic-start"
            disabled={topic.trim().length < 3}
            className="rounded-xl bg-sky-600 px-8 py-3 font-medium text-white disabled:opacity-50"
          >
            Start
          </button>
        </div>
      </form>
    </main>
  );
}
