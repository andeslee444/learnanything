'use client';

/**
 * PrintButton — small client component for `window.print()`.
 *
 * Has the `.no-print` class so it is hidden when the browser prints.
 * testid: `print-doc`
 */
export function PrintButton() {
  return (
    <button
      data-testid="print-doc"
      onClick={() => window.print()}
      className="no-print rounded-lg border border-sky-200 bg-white px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 transition"
      aria-label="Download PDF (print to PDF)"
    >
      Download PDF
    </button>
  );
}
