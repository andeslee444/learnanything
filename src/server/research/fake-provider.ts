import type { ResearchProvider, SearchOptions, SearchSource } from './provider';
import { normalizeDomain } from './trust';

/** Default fixture sources sit on allowlisted domains so the happy path is pre-trusted. */
export const FAKE_SOURCES: SearchSource[] = [
  {
    title: 'Python Tutorial — Official Documentation',
    url: 'https://docs.python.org/3/tutorial/index.html',
    text: 'Python is an easy to learn, powerful programming language. Variables store values under a name. Control flow tools include if statements and for loops. Functions are defined with def and let you reuse logic. Lists and dictionaries are the core data structures.',
    publishedDate: '2026-01-15',
  },
  {
    title: 'MDN: JavaScript first steps',
    url: 'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps',
    text: 'A variable is a container for a value. Loops repeat work without copy-pasting code. Functions bundle reusable behavior. A common misconception is that variables contain values rather than referencing them.',
    publishedDate: '2025-11-02',
  },
  {
    title: 'Real Python: CLI applications',
    url: 'https://realpython.com/command-line-interfaces-python-argparse/',
    text: 'Command-line interfaces parse arguments with argparse. Errors should exit with a nonzero status code. Packaging lets your team install the tool with pip.',
    publishedDate: '2025-09-20',
  },
];

export class FakeProvider implements ResearchProvider {
  calls: SearchOptions[] = []; // tests assert call counts/shape

  constructor(private readonly sources: SearchSource[] = FAKE_SOURCES) {}

  async search(opts: SearchOptions): Promise<SearchSource[]> {
    this.calls.push(opts);
    const include = opts.includeDomains;
    const exclude = new Set(opts.excludeDomains ?? []);
    return this.sources.filter((s) => {
      const domain = normalizeDomain(s.url);
      if (exclude.has(domain)) return false;
      if (include && include.length > 0) return include.includes(domain);
      return true;
    });
  }
}
