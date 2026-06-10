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
