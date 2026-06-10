import { ResearchProviderError, type ResearchProvider, type SearchOptions, type SearchSource } from './provider';

const EXA_URL = 'https://api.exa.ai/search';
const TEXT_MAX_CHARACTERS = 8000;

export class ExaProvider implements ResearchProvider {
  private readonly apiKey: string;

  constructor(apiKey = process.env.EXA_API_KEY) {
    if (!apiKey) {
      throw new ResearchProviderError('EXA_API_KEY is not set (or run with AI_FAKE_LLM=1)');
    }
    this.apiKey = apiKey;
  }

  async search(opts: SearchOptions): Promise<SearchSource[]> {
    let res: Response;
    try {
      res = await fetch(EXA_URL, {
        signal: AbortSignal.timeout(15_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify({
          query: opts.query,
          type: 'auto',
          numResults: opts.numResults ?? 10,
          ...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
          ...(opts.excludeDomains?.length ? { excludeDomains: opts.excludeDomains } : {}),
          text: { maxCharacters: TEXT_MAX_CHARACTERS },
        }),
      });
    } catch (err) {
      const name = (err as Error)?.name ?? '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ResearchProviderError('Exa search timed out', undefined, { cause: err });
      }
      throw new ResearchProviderError(`Exa search network error: ${(err as Error).message}`, undefined, { cause: err });
    }
    if (!res.ok) {
      throw new ResearchProviderError(`Exa search failed: ${res.status}`, res.status);
    }
    let data: { results: Array<{ title?: string; url: string; text?: string; publishedDate?: string; author?: string }> };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      throw new ResearchProviderError('Exa search returned invalid JSON', res.status, { cause: err });
    }
    return (data.results ?? [])
      .filter((r) => r.url && (r.text ?? '').trim().length > 0)
      .map((r) => ({
        title: r.title ?? r.url,
        url: r.url,
        text: r.text!,
        publishedDate: r.publishedDate,
        author: r.author,
      }));
  }
}
