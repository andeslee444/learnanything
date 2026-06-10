import type { Metadata } from 'next';
import { Figtree } from 'next/font/google';
import './globals.css';

const figtree = Figtree({ subsets: ['latin'], variable: '--font-figtree' });

export const metadata: Metadata = {
  title: 'LearnAnything',
  description: 'You can learn anything. One small, beautiful lesson at a time.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
