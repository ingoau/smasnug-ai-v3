import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../features/guard.js', () => ({ takeLimit: async () => null, recordModelUsage: async () => {} }));

const { runWebSearch, EXA_SEARCH_URL, formatAnthropicResults, resetWebSearchCooldown } = await import('./web-search.js');
const { ProviderCooldown } = await import('../models.js');

const ctx = { speakerId: 'U0WEB', threadId: 'C1:1.0' };
const HC_BUDGET_MSG = 'Request would exceed the OpenRouter top-up wait spending limit for today';
const exaOk = { results: [{ title: 'T', url: 'https://a.example/', highlights: ['h'] }] };

/** Fake fetch: Hack Club proxy answers with `hc`, Exa direct always succeeds. */
function fakeFetch(hc: () => Response) {
  const urls: string[] = [];
  const f = (async (url: any) => {
    urls.push(String(url));
    return String(url).includes('hackclub') ? hc() : Response.json(exaOk);
  }) as typeof fetch;
  return { f, urls };
}

describe('web_search Hack Club proxy cooldown', () => {
  it('a spending-limit 429 skips the proxy for the rest of the day', async () => {
    const cooldown = new ProviderCooldown('test exa');
    const { f, urls } = fakeFetch(() => Response.json({ error: { message: HC_BUDGET_MSG } }, { status: 429 }));
    const deps = { apiKey: 'k_exa', hackclubKey: 'sk-hc', fetch: f, hackclubCooldown: cooldown };
    expect(await runWebSearch(ctx, { query: 'q' }, deps)).toHaveProperty('sources');
    expect(await runWebSearch(ctx, { query: 'q' }, deps)).toHaveProperty('sources');
    expect(urls).toEqual([expect.stringContaining('hackclub'), EXA_SEARCH_URL, EXA_SEARCH_URL]);
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    expect(cooldown.skipUntil).toBe(midnight.getTime());
  });

  it('a plain 429 is a short cooldown (Retry-After)', async () => {
    const cooldown = new ProviderCooldown('test exa');
    const { f } = fakeFetch(() => new Response('Too many requests', { status: 429, headers: { 'retry-after': '5' } }));
    const before = Date.now();
    await runWebSearch(ctx, { query: 'q' }, { apiKey: 'k_exa', hackclubKey: 'sk-hc', fetch: f, hackclubCooldown: cooldown });
    expect(cooldown.skipUntil).toBeGreaterThanOrEqual(before + 5_000);
    expect(cooldown.skipUntil).toBeLessThan(before + 60_000);
  });

  it('a 500 sets no cooldown', async () => {
    const cooldown = new ProviderCooldown('test exa');
    const { f, urls } = fakeFetch(() => new Response('boom', { status: 500 }));
    const deps = { apiKey: 'k_exa', hackclubKey: 'sk-hc', fetch: f, hackclubCooldown: cooldown };
    await runWebSearch(ctx, { query: 'q' }, deps);
    await runWebSearch(ctx, { query: 'q' }, deps);
    expect(urls.filter((u) => u.includes('hackclub'))).toHaveLength(2);
    expect(cooldown.active()).toBe(false);
  });

  it('with only the proxy configured and it cooling down: a short message, no request', async () => {
    const cooldown = new ProviderCooldown('test exa');
    const { f, urls } = fakeFetch(() => new Response(JSON.stringify({ error: HC_BUDGET_MSG }), { status: 429 }));
    const deps = { apiKey: undefined, hackclubKey: 'sk-hc', fetch: f, hackclubCooldown: cooldown };
    expect(await runWebSearch(ctx, { query: 'q' }, deps)).toMatch(/^Web search failed \(HTTP 429\)/);
    expect(await runWebSearch(ctx, { query: 'q' }, deps)).toMatch(/^Web search is unavailable right now/);
    expect(urls).toHaveLength(1);
  });
});

/** What generateText returns for one Claude call with the web_search server tool (the parts we read). */
const claudeSearchResult = () => ({
  content: [
    { type: 'tool-call', toolName: 'web_search', input: { query: 'q' } },
    {
      type: 'tool-result',
      toolName: 'web_search',
      output: [
        { type: 'web_search_result', url: 'https://b.example/', title: 'Uncited', pageAge: null, encryptedContent: 'x' },
        { type: 'web_search_result', url: 'https://a.example/', title: 'Cited  page', pageAge: 'March 3, 2026', encryptedContent: 'x' },
        { type: 'web_search_result', url: 'javascript:alert(1)', title: 'bad', pageAge: null, encryptedContent: 'x' },
      ],
    },
    {
      type: 'text',
      text: 'A says the thing.',
      providerMetadata: { anthropic: { citations: [{ type: 'web_search_result_location', url: 'https://a.example/', title: 'Cited page', cited_text: 'the  thing', encrypted_index: 'i' }] } },
    },
  ],
  usage: { inputTokens: 900, outputTokens: 40 },
});

describe('web_search Anthropic fallback', () => {
  it('renders cited results first, with their passages and the notes, as untrusted content', () => {
    const out = formatAnthropicResults('q', claudeSearchResult().content, 5);
    expect(out.sources).toEqual([
      { url: 'https://a.example/', title: 'Cited page' },
      { url: 'https://b.example/', title: 'Uncited' },
    ]);
    expect(out.text).toContain('1. Cited page\n   https://a.example/\n   March 3, 2026\n   > the thing');
    expect(out.text).toContain('Search notes:\nA says the thing.');
    expect(out.text).not.toContain('javascript:');
    expect(formatAnthropicResults('q', claudeSearchResult().content, 1).sources).toHaveLength(1);
    expect(formatAnthropicResults('q', [], 5).text).toBe('No web results for "q".');
  });

  it('runs after the Hack Club proxy fails and before Exa direct; credit out → skipped until midnight', async () => {
    resetWebSearchCooldown();
    const { f, urls } = fakeFetch(() => new Response('boom', { status: 500 }));
    const search = vi.fn(async () => claudeSearchResult());
    const deps = { apiKey: 'k_exa', hackclubKey: 'sk-hc', fetch: f, hackclubCooldown: new ProviderCooldown('test exa'), anthropicSearch: search };
    const out = await runWebSearch(ctx, { query: 'q' }, deps);
    expect(out).toMatchObject({ sources: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }] });
    expect(urls).toEqual([expect.stringContaining('hackclub')]);

    const broke = vi.fn(async () => {
      throw Object.assign(new Error('Your credit balance is too low to access the Anthropic API.'), { statusCode: 400 });
    });
    const deps2 = { ...deps, anthropicSearch: broke };
    expect(await runWebSearch(ctx, { query: 'q' }, deps2)).toMatchObject({ sources: [{ url: 'https://a.example/' }] }); // Exa direct
    await runWebSearch(ctx, { query: 'q' }, deps2);
    expect(broke).toHaveBeenCalledTimes(1);
    expect(urls.filter((u) => u === EXA_SEARCH_URL)).toHaveLength(2);
    resetWebSearchCooldown();
  });
});

describe('web_search Anthropic search problems', () => {
  it('a search error or no search at all falls through to Exa direct instead of "no results"', async () => {
    resetWebSearchCooldown();
    const failed = { content: [{ type: 'tool-call', toolName: 'web_search' }, { type: 'tool-error', toolName: 'web_search', error: { errorCode: 'too_many_requests' } }], usage: {} };
    const skipped = { content: [{ type: 'text', text: 'I think the answer is 42.' }], usage: {} };
    for (const res of [failed, skipped]) {
      const { f, urls } = fakeFetch(() => new Response('boom', { status: 500 }));
      const search = vi.fn(async () => res);
      const out = await runWebSearch(ctx, { query: 'q' }, { apiKey: 'k_exa', hackclubKey: 'sk-hc', fetch: f, hackclubCooldown: new ProviderCooldown('t'), anthropicSearch: search });
      expect(search).toHaveBeenCalledTimes(1);
      expect(out).toMatchObject({ sources: [{ url: 'https://a.example/' }] });
      expect(urls.at(-1)).toBe(EXA_SEARCH_URL);
    }
    // Without Exa direct: a failure message, not "no results".
    const out = await runWebSearch(ctx, { query: 'q' }, { apiKey: undefined, hackclubKey: undefined, anthropicSearch: async () => failed });
    expect(out).toMatch(/^Web search failed/);
  });
});
