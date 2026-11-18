/** view_profile_picture: largest size picked, CDN-only fetches, the picture stored as a file (fake Slack, injected fetcher). */
import './test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { addFakeHandler, fakeSlackError } from '../core/slack-fake.js';
import { fileStore } from '../files/store.js';
import { fetchProfilePicture, isAvatarUrl, largestAvatarUrl, parseUserRef, type AvatarFetcher } from './profile-picture.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const threadId = `${channel}:1790000001.000100`;
const speakerId = `U${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const ctx = { role: 'front' as const, threadId, speakerId, turnId: 1 };

afterAll(async () => {
  await sql`delete from files where channel_id = ${channel}`;
  await sql.end();
  redis.disconnect();
});

describe('largestAvatarUrl', () => {
  it('prefers the original upload, then the biggest size', () => {
    expect(largestAvatarUrl({ image_72: 'a72', image_original: 'orig', image_1024: 'a1024' })).toEqual({ url: 'orig', size: 'original' });
    expect(largestAvatarUrl({ image_72: 'a72', image_512: 'a512', image_192: 'a192' })).toEqual({ url: 'a512', size: '512px' });
    expect(largestAvatarUrl({ image_24: 'a24', image_original: '' })).toEqual({ url: 'a24', size: '24px' });
    expect(largestAvatarUrl({})).toBeNull();
    expect(largestAvatarUrl(undefined)).toBeNull();
  });
});

describe('isAvatarUrl / parseUserRef', () => {
  it('only fetches from Slack\'s CDN or Gravatar over https', () => {
    expect(isAvatarUrl('https://avatars.slack-edge.com/2024-01-01/1_abc_original.jpg')).toBe(true);
    expect(isAvatarUrl('https://secure.gravatar.com/avatar/abc.jpg?s=512&d=https%3A%2F%2Fa.slack-edge.com%2Fdf10d%2Fimg%2Favatars%2Fava_0001-512.png')).toBe(true);
    expect(isAvatarUrl('http://avatars.slack-edge.com/x.jpg')).toBe(false);
    expect(isAvatarUrl('https://slack-edge.com.evil.com/x.jpg')).toBe(false);
    expect(isAvatarUrl('https://example.com/x.jpg')).toBe(false);
    expect(isAvatarUrl('not a url')).toBe(false);
  });

  it('takes ids and mentions', () => {
    expect(parseUserRef('U0123ABCD')).toBe('U0123ABCD');
    expect(parseUserRef(' <@U0123ABCD> ')).toBe('U0123ABCD');
    expect(parseUserRef('<@W0123ABCD|ingo>')).toBe('W0123ABCD');
    expect(parseUserRef('ingo')).toBeNull();
    expect(parseUserRef('C0123ABCD')).toBeNull();
  });
});

describe('fetchProfilePicture', () => {
  it('downloads the largest picture, stores it and loads it for the model', async () => {
    const off = addFakeHandler((method, args) => {
      if (method !== 'users.info' || args.user !== 'U0PIC1') return undefined;
      return {
        ok: true,
        user: {
          id: 'U0PIC1',
          name: 'ingo',
          profile: {
            display_name: 'Ingo',
            is_custom_image: true,
            image_192: 'https://avatars.slack-edge.com/1_192.png',
            image_1024: 'https://avatars.slack-edge.com/1_1024.png',
            image_original: 'https://avatars.slack-edge.com/1_original.png',
          },
        },
      };
    });
    const fetched: string[] = [];
    const fetcher: AvatarFetcher = async (url) => (fetched.push(url), { status: 200, body: PNG, truncated: false });
    try {
      const res = await fetchProfilePicture(ctx, '<@U0PIC1>', { fetch: fetcher });
      if (typeof res === 'string') throw new Error(res);
      expect(fetched).toEqual(['https://avatars.slack-edge.com/1_original.png']);
      expect(res.file.name).toBe('ingo-profile-picture.png');
      expect(res.file.mime).toBe('image/png');
      expect(res.header).toContain('<@U0PIC1|Ingo>');
      expect(res.header).toContain('original');
      expect(res.header).not.toContain('default avatar');
      expect(res.image.width).toBe(1);
      expect((await fileStore.get(res.file.id))?.equals(PNG)).toBe(true);
      const [row] = await sql<{ description: string }[]>`select description from files where id = ${res.file.id}`;
      expect(row!.description).toContain('profile picture of Ingo');
      // Same turn, same picture: the same file.
      const again = await fetchProfilePicture(ctx, 'U0PIC1', { fetch: fetcher });
      if (typeof again === 'string') throw new Error(again);
      expect(again.file.id).toBe(res.file.id);
    } finally {
      off();
    }
  });

  it('says when it is the default avatar, and explains what it can\'t fetch', async () => {
    const off = addFakeHandler((method, args) => {
      if (method !== 'users.info') return undefined;
      if (args.user === 'U0DEF') return { ok: true, user: { id: 'U0DEF', name: 'bob', profile: { real_name: 'Bob', is_custom_image: false, image_512: 'https://secure.gravatar.com/avatar/x.png?s=512' } } };
      if (args.user === 'U0EVIL') return { ok: true, user: { id: 'U0EVIL', name: 'eve', profile: { image_512: 'https://evil.example.com/x.png' } } };
      if (args.user === 'U0NONE') return { ok: true, user: { id: 'U0NONE', name: 'nobody', profile: {} } };
      if (args.user === 'U0HTML') return { ok: true, user: { id: 'U0HTML', name: 'h', profile: { image_512: 'https://avatars.slack-edge.com/h.png' } } };
      throw fakeSlackError('user_not_found');
    });
    const fetcher: AvatarFetcher = async (url) => ({ status: 200, body: url.includes('/h.png') ? Buffer.from('<html></html>') : PNG, truncated: false });
    try {
      const def = await fetchProfilePicture(ctx, 'U0DEF', { fetch: fetcher });
      if (typeof def === 'string') throw new Error(def);
      expect(def.header).toContain('default avatar');
      expect(await fetchProfilePicture(ctx, 'U0EVIL', { fetch: fetcher })).toContain("isn't on Slack's CDN");
      expect(await fetchProfilePicture(ctx, 'U0NONE', { fetch: fetcher })).toContain('has no profile picture');
      expect(await fetchProfilePicture(ctx, 'U0HTML', { fetch: fetcher })).toContain("isn't an image");
      expect(await fetchProfilePicture(ctx, 'U0MISSING', { fetch: fetcher })).toContain('No Slack user U0MISSING');
      expect(await fetchProfilePicture(ctx, 'bob', { fetch: fetcher })).toContain("isn't a Slack user id");
    } finally {
      off();
    }
  });
});
