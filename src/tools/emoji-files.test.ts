/**
 * upload_emoji against the fake Slack client: emoji.add as the userbot, with the image bytes, and no second call
 * when the same turn retries.
 */
import './emoji-upload-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { addFakeHandler, fakeSlackError } from '../core/slack-fake.js';
import { SlackUpload, userbotConfigured } from '../core/slack.js';
import { toolsFor, type ToolContext } from '../core/tools.js';
import { createFile } from '../files/store.js';
import { emojiImageProblem, uploadEmoji } from './emoji-files.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const threadId = `${channel}:1790000001.000100`;
const speakerId = `U${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

const ctx = (turnId: number): Pick<ToolContext, 'threadId' | 'speakerId' | 'turnId' | 'runId'> => ({ threadId, speakerId, turnId });

afterAll(async () => {
  await sql`delete from files where channel_id = ${channel}`;
  await sql`delete from idempotency_keys where key like ${'emoji.add:emoji-add:' + threadId + ':%'}`;
  await sql`delete from usage where user_id = ${speakerId}`;
  await redis.del(`limit:emoji_upload:${speakerId}`);
  delete process.env.SLACK_USERBOT_TOKEN;
  delete process.env.SLACK_USERBOT_COOKIE;
  await sql.end();
  redis.disconnect();
});

describe('upload_emoji', () => {
  it('is registered for the front agent when the userbot session is set', () => {
    expect(userbotConfigured()).toBe(true);
    const front = toolsFor('front', { threadId, channelId: channel, threadTs: '1790000001.000100', speakerId, extras: {} });
    expect(front.upload_emoji).toBeTypeOf('object');
    expect(toolsFor('child', { threadId, channelId: channel, threadTs: '1790000001.000100', speakerId, extras: {} }).upload_emoji).toBeUndefined();
  });

  it('sends emoji.add as the userbot with the image, and a retry of the same turn does not send it again', async () => {
    const adds: { token: string; args: Record<string, unknown> }[] = [];
    const remove = addFakeHandler((method, args, token) => {
      if (method !== 'emoji.add') return undefined;
      adds.push({ token, args });
      return { ok: true };
    });
    try {
      const f = await createFile({ threadId, ownerId: speakerId, name: 'wave.png', content: PNG, description: 'a wave' });
      const out = await uploadEmoji(ctx(1), ':Cat Wave:', f.id);
      expect(out).toBe(`Added :cat_wave: from ${f.id}.`);
      expect(adds).toHaveLength(1);
      expect(adds[0]!.token).toBe('userbot');
      expect(adds[0]!.args.name).toBe('cat_wave');
      expect(adds[0]!.args.mode).toBe('data');
      const image = adds[0]!.args.image as SlackUpload;
      expect(image).toBeInstanceOf(SlackUpload);
      expect(image.filename).toBe('wave.png');
      expect(image.contentType).toBe('image/png');
      expect(image.bytes.equals(PNG)).toBe(true);
      expect(await uploadEmoji(ctx(1), 'cat_wave', f.id)).toBe(`Added :cat_wave: from ${f.id}.`);
      expect(adds).toHaveLength(1);
    } finally {
      remove();
    }
  });

  it('reports a taken name and does not upload a file that is not an image', async () => {
    const remove = addFakeHandler((method, args) => {
      if (method === 'emoji.add' && args.name === 'taken') throw fakeSlackError('error_name_taken');
      return undefined;
    });
    try {
      const img = await createFile({ threadId, ownerId: speakerId, name: 'taken.png', content: PNG, description: 'taken' });
      expect(await uploadEmoji(ctx(2), 'taken', img.id)).toBe('That emoji name is already taken.');
      const text = await createFile({ threadId, ownerId: speakerId, name: 'notes.txt', content: Buffer.from('hello'), description: 'notes' });
      expect(await uploadEmoji(ctx(3), 'notes', text.id)).toMatch(/GIF, JPEG, PNG, or WEBP/);
      expect(await uploadEmoji(ctx(4), '!!!', img.id)).toMatch(/isn't usable/);
    } finally {
      remove();
    }
  });

  it('refuses an image over the upload cap before calling Slack', () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1);
    PNG.copy(big);
    expect(emojiImageProblem(big, 'image/png')).toMatchObject({ error: expect.stringMatching(/limit/) });
    expect(emojiImageProblem(PNG, 'application/octet-stream')).toMatchObject({ mime: 'image/png', ext: 'png' });
  });
  it('counts the hourly limit only for added emoji, and reports a lost answer as unknown', async () => {
    const usage = async () => Number((await sql`select count(*)::int as n from usage where user_id = ${speakerId} and kind = 'emoji_upload'`)[0]!.n);
    const before = await usage();
    const f = await createFile({ threadId, ownerId: speakerId, name: 'x.png', content: PNG, description: 'x' });
    let off = addFakeHandler((method) => {
      if (method === 'emoji.add') throw fakeSlackError('error_name_taken');
      return undefined;
    });
    try {
      expect(await uploadEmoji(ctx(20), 'already_there', f.id)).toBe('That emoji name is already taken.');
    } finally {
      off();
    }
    expect(await usage()).toBe(before);
    off = addFakeHandler((method) => {
      if (method === 'emoji.add') throw Object.assign(new Error('timeout'), { code: 'slack_webapi_request_error' });
      return undefined;
    });
    try {
      expect(await uploadEmoji(ctx(21), 'slow_one', f.id)).toMatch(/may or may not have been added/);
    } finally {
      off();
    }
    expect(await usage()).toBe(before);
    expect(await uploadEmoji(ctx(22), 'fresh_one', f.id)).toBe(`Added :fresh_one: from ${f.id}.`);
    expect(await usage()).toBe(before + 1);
  });
});
