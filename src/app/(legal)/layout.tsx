/**
 * Legal layout — minimal shell with header and footer.
 * No auth required; these pages are fully public.
 */
import Link from 'next/link';
import { Footer } from '@/components/footer';

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-cloud">
      <header className="border-b border-ink-400/20 px-6 py-4">
        <Link href="/" className="text-lg font-medium text-sky-700">
          LearnAnything
        </Link>
      </header>
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
