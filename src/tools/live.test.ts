/**
 * LIVE tests (real OpenRouter + internet; Slack still faked). Run: LIVE=1 pnpm vitest run src/tools/live.test.ts
 * They answer the design doc's open questions:
 *  - web_search (Exa) returns results with highlights and source URLs (no model call);
 *  - GPT-6 Luna accepts images inside tool results.
 */
import './test-env.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { generateText, stepCountIs } from 'ai';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from '../core/redis.js';
import { threadIdOf } from '../core/events.js';
import { toolsFor } from '../core/tools.js';
import { openrouter, MODELS } from '../models.js';
import { ensureThread } from '../context/thread.js';
import { assignImageIds } from '../context/images.js';
import './index.js';
import { loadThreadImage } from './read-image.js';
import { runWebSearch, type WebSearchOutput } from './web-search.js';
import { fetchPage } from './fetch-url.js';

const LIVE = process.env.LIVE === '1';
const channel = `C${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const threadTs = '1790000000.000100';
const threadId = threadIdOf(channel, threadTs);
const ctx = { threadId, channelId: channel, threadTs, speakerId: 'U0LIVE', extras: {} };

afterAll(async () => {
  await sql`delete from threads where channel_id = ${channel}`;
  await sql.end();
  redis.disconnect();
});

describe.skipIf(!LIVE)('live', () => {
  it.skipIf(!process.env.EXA_API_KEY)('web_search: Exa returns highlighted results with URLs (one instant search, $0.004)', async () => {
    const out = (await runWebSearch(ctx, { query: 'latest Node.js LTS release', num_results: 3 })) as WebSearchOutput;
    console.log('web_search:', typeof out === 'string' ? out : out.text.slice(0, 600));
    expect(typeof out).toBe('object');
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.text).toContain(out.sources[0]!.url);
    expect(out.text).toContain('   > ');
  }, 30_000);

  it('read_image: the model reads an image returned inside a tool result (Luna)', async () => {
    await ensureThread(threadId);
    // A public image fetched through the real download path (SLACK_FAKE allows public URLs without auth).
    await assignImageIds(threadId, [
      {
        ts: '1790000001.000100',
        userId: 'U0LIVE',
        botId: null,
        username: null,
        text: '',
        files: [{ id: 'FLIVEDICE', name: 'dice.png', mimetype: 'image/png', urlPrivate: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png' }],
      },
      { ts: '1790000002.000100', userId: 'U0LIVE', botId: null, username: null, text: '', files: [{ id: 'FLIVEHEIC', name: 'photo.heic', mimetype: 'image/heic' }] },
    ]);
    // Prime the HEIC through the converter (local fixture: yellow circle on blue).
    const heic = await readFile(path.join(import.meta.dirname, '__fixtures__/sample.heic'));
    const primed = await loadThreadImage(threadId, 'img_2', async () => heic);
    expect(typeof primed).not.toBe('string');

    for (const model of [MODELS.front]) {
      const tools = { read_image: toolsFor('child', ctx).read_image! };
      const r = await generateText({
        model: openrouter(model, { reasoning: { effort: 'low' } }),
        prompt: 'Call read_image for img_1 and img_2. Then answer in one line: what objects are in img_1, and what shape and colors are in img_2?',
        tools,
        stopWhen: stepCountIs(3),
      });
      console.info(`[live] ${model} → ${r.text}`);
      expect(r.text).toMatch(/dice|die\b/i);
      expect(r.text).toMatch(/yellow/i);
      expect(r.text).toMatch(/blue/i);
    }
  }, 180_000);

  it('fetch_url: real page', async () => {
    const page = await fetchPage('https://example.com/');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/Example Domain|documentation/i);
  }, 30_000);
});
