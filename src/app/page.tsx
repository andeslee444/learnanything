import Link from 'next/link';
import { Footer } from '@/components/footer';

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex flex-1 flex-col items-center justify-center bg-gradient-to-b from-sky-100 via-sky-50 to-cloud px-6">
        <h1 className="max-w-2xl text-center text-5xl font-medium tracking-tight text-ink-900">
          You can learn <span className="text-sky-600">anything</span>
        </h1>
        <p className="mt-6 max-w-md text-center text-lg text-ink-600">
          One small, beautiful lesson at a time — grounded in real sources, shaped around why you want to learn.
        </p>
        <div className="mt-10 flex gap-4">
          <Link href="/signup" className="rounded-xl bg-sky-600 px-6 py-3 font-medium text-white">
            Start learning
          </Link>
          <Link href="/login" className="rounded-xl border border-sky-300 px-6 py-3 font-medium text-sky-700">
            Log in
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}
