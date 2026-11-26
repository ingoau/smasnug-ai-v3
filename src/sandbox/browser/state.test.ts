import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { filterState, parseState, stateCounts, stateDomains } from './state.js';

const state = {
  cookies: [
    { name: 'sid', value: 'a', domain: '.github.com', path: '/' },
    { name: 'x', value: 'b', domain: 'github.com', path: '/' },
    { name: 'api', value: 'c', domain: 'api.github.com', path: '/' },
    { name: 'ga', value: 'd', domain: '.google-analytics.com', path: '/' },
    { name: 'bad', value: 'e' },
  ],
  origins: [
    { origin: 'https://github.com', localStorage: [{ name: 'k', value: 'v' }] },
    { origin: 'https://www.example.org', localStorage: [] },
    { origin: 'chrome-extension://abc' },
  ],
  extra: 1,
};

describe('parseState', () => {
  it('parses objects and refuses other JSON', () => {
    expect(parseState(JSON.stringify(state))?.cookies).toHaveLength(5);
    expect(parseState('[]')).toBeNull();
    expect(parseState('{"cookies": {}}')).toBeNull();
    expect(parseState('not json')).toBeNull();
    expect(parseState('{}')).toEqual({});
  });
});

describe('stateDomains', () => {
  it('lists sites, folding subdomains into their parent', () => {
    expect(stateDomains(state)).toEqual(['github.com', 'google-analytics.com', 'www.example.org']);
    expect(stateDomains({})).toEqual([]);
  });
});

describe('filterState', () => {
  it('keeps one site: its cookies, parent-domain cookies it receives, and its storage', () => {
    const f = filterState(state, ['github.com']);
    expect(f.cookies!.map((c) => c.name)).toEqual(['sid', 'x', 'api']);
    expect(f.origins!.map((o) => o.origin)).toEqual(['https://github.com']);
    expect(f.extra).toBe(1);
    const sub = filterState(state, ['app.github.com']);
    expect(sub.cookies!.map((c) => c.name)).toEqual(['sid', 'x']);
    expect(sub.origins).toEqual([]);
    expect(stateCounts(f)).toEqual({ cookies: 3, origins: 1 });
  });
});
