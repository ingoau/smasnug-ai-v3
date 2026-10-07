import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../features/guard.js', () => ({ takeLimit: async () => null }));

const { runWebSearch, EXA_SEARCH_URL } = await import('./web-search.js');
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
