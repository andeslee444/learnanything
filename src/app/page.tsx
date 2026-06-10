export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-sky-100 via-sky-50 to-cloud px-6">
      <h1 className="max-w-2xl text-center text-5xl font-medium tracking-tight text-ink-900">
        You can learn <span className="text-sky-600">anything</span>
      </h1>
      <p className="mt-6 max-w-md text-center text-lg text-ink-600">
        One small, beautiful lesson at a time — grounded in real sources, shaped around why you want to learn.
      </p>
      <div className="mt-10 rounded-xl bg-sun-100 px-4 py-2 text-sm text-sun-700">
        Phase 1 foundation — onboarding arrives in Phase 2
      </div>
    </main>
  );
}
