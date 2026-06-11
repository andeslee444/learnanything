import Link from 'next/link';

/**
 * Shared footer — links to /privacy and /terms.
 * Mounted in both the app shell layout and the public landing page layout.
 */
export function Footer() {
  return (
    <footer className="border-t border-ink-400/20 px-6 py-5 text-center">
      <nav aria-label="Legal links" className="flex items-center justify-center gap-6">
        <Link
          href="/privacy"
          data-testid="footer-privacy"
          className="text-xs text-ink-400 hover:text-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Privacy Policy
        </Link>
        <Link
          href="/terms"
          data-testid="footer-terms"
          className="text-xs text-ink-400 hover:text-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Terms of Service
        </Link>
      </nav>
    </footer>
  );
}
