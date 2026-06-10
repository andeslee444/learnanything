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
    setBusy(false);
    router.push('/tracks');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-sky-100 to-cloud px-6">
      <form onSubmit={submit} className="w-full max-w-md rounded-xl bg-cloud p-8 shadow-sm">
        <h1 className="text-2xl font-medium text-ink-900">Welcome back</h1>
        <input className="mt-6 w-full rounded-md border border-ink-400/40 bg-white p-3" type="email" placeholder="Email"
          value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" autoComplete="email" required />
        <input className="mt-3 w-full rounded-md border border-ink-400/40 bg-white p-3" type="password" placeholder="Password"
          value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" autoComplete="current-password" required />
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
