export type SearchSource = {
  title: string;
  url: string;
  text: string; // page text (bounded by maxCharacters at fetch time)
  publishedDate?: string;
  author?: string;
};

export type SearchOptions = {
  query: string;
  includeDomains?: string[]; // ≤1200 (Exa limit)
  excludeDomains?: string[];
  numResults?: number; // default 10
};

export interface ResearchProvider {
  search(opts: SearchOptions): Promise<SearchSource[]>;
}

export class ResearchProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ResearchProviderError';
  }
}

/** Runtime selection. Tests inject providers directly — don't use this in tests. */
export async function getResearchProvider(): Promise<ResearchProvider> {
  if (process.env.AI_FAKE_LLM === '1') {
    const { FakeProvider } = await import('./fake-provider');
    return new FakeProvider();
  }
  const { ExaProvider } = await import('./exa-provider');
  return new ExaProvider();
}
