'use client';

import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';
import type { articleBlockSchema } from '@/server/lessons/blocks';
import type { z } from 'zod';

type ArticleBlock = z.infer<typeof articleBlockSchema>;

type Props = {
  block: ArticleBlock;
};

export function ArticleSection({ block }: Props) {
  return (
    <section data-testid="article-block" className="mt-6">
      <h3 className="text-lg font-semibold text-ink-900">{block.heading}</h3>
      <div className="mt-3 prose prose-ink max-w-none text-ink-900 text-base leading-relaxed">
        <Streamdown mode="static">{block.markdown}</Streamdown>
      </div>
      {block.citationUrls.length > 0 && (
        <footer className="mt-4 pt-3 border-t border-ink-400/20">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-400">Sources</p>
          <ul className="mt-1 flex flex-col gap-1">
            {block.citationUrls.map((url) => (
              <li key={url}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-sky-600 hover:text-sky-700 underline underline-offset-2 break-all"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </section>
  );
}
