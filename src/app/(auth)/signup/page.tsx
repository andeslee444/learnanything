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

    // NOTE: orphan-user guard — if a session already exists (user has an account
    // but no learner row), skip signUp and only POST /api/learner.
    const sessionResult = await authClient.getSession();
    const hasExistingUser = !!sessionResult?.data?.user;

    if (!hasExistingUser) {
      const { error: signUpError } = await authClient.signUp.email({ name, email, password });
      if (signUpError) {
        setError(signUpError.message ?? 'Sign up failed.');
        setBusy(false);
        return;
      }
    }

    const res = await fetch('/api/learner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: hasExistingUser ? (sessionResult?.data?.user?.name ?? name) : name, ageBand: band }),
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
          <h1 className="text-3xl font-medium text-ink-900">We&apos;re not quite ready for you yet</h1>
          <p className="mt-4 text-ink-600">
            LearnAnything doesn&apos;t offer accounts for your age group yet. We&apos;re working on a version
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
                I have a parent or guardian&apos;s permission to use LearnAnything.
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
