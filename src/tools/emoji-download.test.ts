/** download_emoji: alias resolution, CDN-only fetches, files stored per emoji (fake Slack, injected fetcher). */
import './test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { addFakeHandler } from '../core/slack-fake.js';
import { fileStore } from '../files/store.js';
import { downloadEmojis, forgetEmojiList, isEmojiImageUrl, lookupEmoji, type EmojiFetcher } from './emoji-download.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const threadId = `${channel}:1790000001.000100`;
const speakerId = `U${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

const LIST = {
  partyparrot: 'https://emoji.slack-edge.com/T1/partyparrot/abc.png',
  parrot: 'alias:partyparrot',
  yay: 'alias:tada',
  sneaky: 'https://evil.example.com/x.png',
  loop1: 'alias:loop2',
  loop2: 'alias:loop1',
};

afterAll(async () => {
  await forgetEmojiList();
  await sql`delete from files where channel_id = ${channel}`;
  await sql.end();
  redis.disconnect();
});

describe('lookupEmoji', () => {
  it('follows aliases, tells standard aliases from missing names, stops on loops', () => {
    expect(lookupEmoji(LIST, ':PartyParrot:')).toEqual({ kind: 'custom', name: 'partyparrot', url: LIST.partyparrot });
    expect(lookupEmoji(LIST, 'parrot')).toEqual({ kind: 'custom', name: 'parrot', url: LIST.partyparrot, aliasOf: 'partyparrot' });
    expect(lookupEmoji(LIST, 'yay')).toEqual({ kind: 'standard', name: 'yay' });
    expect(lookupEmoji(LIST, 'thumbsup')).toEqual({ kind: 'missing', name: 'thumbsup' });
    expect(lookupEmoji(LIST, 'loop1').kind).toBe('missing');
    expect(lookupEmoji(LIST, 'constructor')).toEqual({ kind: 'missing', name: 'constructor' });
    expect(lookupEmoji({ a: 'alias:__proto__' }, 'a').kind).toBe('standard');
  });

  it('only fetches from Slack\'s CDN', () => {
    expect(isEmojiImageUrl(LIST.partyparrot)).toBe(true);
    expect(isEmojiImageUrl('http://emoji.slack-edge.com/x.png')).toBe(false);
    expect(isEmojiImageUrl('https://slack-edge.com.evil.com/x.png')).toBe(false);
    expect(isEmojiImageUrl(LIST.sneaky)).toBe(false);
  });
});

describe('downloadEmojis', () => {
  it('stores each custom emoji as a file and explains the rest', async () => {
    await forgetEmojiList();
    let lists = 0;
    const off = addFakeHandler((method) => {
      if (method !== 'emoji.list') return undefined;
      lists++;
      return { ok: true, emoji: LIST };
    });
    const fetched: string[] = [];
    const fetcher: EmojiFetcher = async (url) => (fetched.push(url), { status: 200, body: PNG, truncated: false });
    try {
      const ctx = { role: 'front' as const, threadId, speakerId, turnId: 1 };
      const out = await downloadEmojis(ctx, ['partyparrot', ':parrot:', 'yay', 'nope', 'sneaky'], { fetch: fetcher });
      const ids = [...out.matchAll(/file_\w+/g)].map((m) => m[0]);
      expect(ids).toHaveLength(2);
      expect(out).toMatch(/:parrot: file_\w+ \(parrot\.png, .*alias of :partyparrot:\)/);
      expect(out).toMatch(/:yay: is an alias of a standard emoji/);
      expect(out).toMatch(/:nope: no custom emoji/);
      expect(out).toMatch(/:sneaky: its image isn't on Slack's emoji CDN/);
      expect(out).toMatch(/reply\(files/);
      expect(fetched).toEqual([LIST.partyparrot, LIST.partyparrot]);
      const meta = await fileStore.metadata(ids[0]!);
      expect(meta).toMatchObject({ name: 'partyparrot.png', mime: 'image/png', ownerId: speakerId, threadId });
      expect((await fileStore.get(ids[0]!))!.equals(PNG)).toBe(true);
      // The list is cached; the same turn retrying gets the same files.
      const again = await downloadEmojis(ctx, ['partyparrot'], { fetch: fetcher });
      expect(again).toContain(ids[0]!);
      expect(lists).toBe(1);
    } finally {
      off();
    }
  });

  it('refuses non-images and caps the batch', async () => {
    await forgetEmojiList();
    const off = addFakeHandler((method) => (method === 'emoji.list' ? { ok: true, emoji: LIST } : undefined));
    try {
      const ctx = { role: 'child' as const, threadId, speakerId, runId: 7 };
      const html: EmojiFetcher = async () => ({ status: 200, body: Buffer.from('<html>'), truncated: false });
      expect(await downloadEmojis(ctx, ['partyparrot'], { fetch: html })).toMatch(/isn't an image/);
      const many = Array.from({ length: 11 }, (_, i) => `e${i}`);
      expect(await downloadEmojis(ctx, many)).toMatch(/At most 10/);
      const png: EmojiFetcher = async () => ({ status: 200, body: PNG, truncated: false });
      expect(await downloadEmojis(ctx, ['partyparrot'], { fetch: png, budget: { left: 0 } })).toMatch(/not saved: already \d+ files downloaded this run/);
    } finally {
      off();
    }
  });
});
