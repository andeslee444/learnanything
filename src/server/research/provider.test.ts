import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExaProvider } from './exa-provider';
import { FakeProvider } from './fake-provider';
import { ResearchProviderError } from './provider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ExaProvider', () => {
  it('sends the verified request shape and maps results', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'T', url: 'https://docs.python.org/x', text: 'body', publishedDate: '2026-01-01' },
          { url: 'https://no-text.example', text: '' }, // dropped: empty text
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ExaProvider('test-key');
    const results = await provider.search({ query: 'q', includeDomains: ['docs.python.org'], numResults: 5 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.exa.ai/search');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ query: 'q', type: 'auto', numResults: 5, includeDomains: ['docs.python.org'] });
    expect(body.text.maxCharacters).toBe(8000);
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'test-key' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'T', url: 'https://docs.python.org/x', text: 'body' });
  });

  it('throws ResearchProviderError on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    await expect(new ExaProvider('k').search({ query: 'q' })).rejects.toThrow(ResearchProviderError);
  });

  it('requires a key outside fake mode', () => {
    vi.stubEnv('EXA_API_KEY', '');
    expect(() => new ExaProvider(undefined)).toThrow(ResearchProviderError);
  });
});

describe('FakeProvider', () => {
  it('filters by include/exclude domains and records calls', async () => {
    const fake = new FakeProvider();
    const all = await fake.search({ query: 'q' });
    expect(all.length).toBeGreaterThanOrEqual(3);
    const only = await fake.search({ query: 'q', includeDomains: ['docs.python.org'] });
    expect(only).toHaveLength(1);
    const excluded = await fake.search({ query: 'q', excludeDomains: ['docs.python.org'] });
    expect(excluded.find((s) => s.url.includes('docs.python.org'))).toBeUndefined();
    expect(fake.calls).toHaveLength(3);
  });
});
