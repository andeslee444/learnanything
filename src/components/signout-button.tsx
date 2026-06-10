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
