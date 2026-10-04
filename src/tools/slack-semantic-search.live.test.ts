/**
 * LIVE=1 + a real SLACK_USER_TOKEN / SLACK_BOT_TOKEN (app reinstalled with the `search:read.public` user scope):
 * one real assistant.search.context call through slack_semantic_search, plus the public-channel check. Unlike the
 * other live tests this talks to real Slack (read-only; test Postgres/Redis), so it needs the tokens set:
 *   LIVE=1 pnpm vitest run src/tools/slack-semantic-search.live.test.ts
 */
import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

if (existsSync('.env')) process.loadEnvFile('.env');
const LIVE = process.env.LIVE === '1' && !!process.env.SLACK_USER_TOKEN?.startsWith('xoxp-') && !!process.env.SLACK_BOT_TOKEN;
// Real Slack for this file only: set before the app modules are (dynamically) imported.
if (LIVE) process.env.SLACK_FAKE = '0';
process.env.OPENROUTER_KEY ??= 'test';

describe.skipIf(!LIVE)('live: slack_semantic_search (real Slack)', () => {
  afterAll(async () => {
    const { sql } = await import('../db/index.js');
    const { redis } = await import('../core/redis.js');
    await sql`delete from usage where user_id = 'U0LIVERTS'`;
    await sql.end();
    redis.disconnect();
  });

  it('returns only verified public-channel results, formatted like slack_search', async () => {
    const { slackCall } = await import('../core/slack.js');
    const { toolsFor } = await import('../core/tools.js');
    await import('./index.js');
    const { publicChannelIds } = await import('./slack-search.js');
    const { buildRtsArgs } = await import('./slack-semantic-search.js');

    const info = await slackCall<any>('assistant.search.info', {}, { token: 'user' });
    console.log('assistant.search.info:', info);

    // The raw response shape we rely on (field names from docs.slack.dev).
    const raw = await slackCall<any>('assistant.search.context', buildRtsArgs({ query: 'what is happening this week?' }), { token: 'user' });
    const msgs: any[] = raw.results?.messages ?? [];
    console.log('raw sample:', JSON.stringify(msgs[0] ?? null, null, 2).slice(0, 1500));
    if (msgs[0]) expect(msgs[0]).toHaveProperty('channel_id');
    const pub = await publicChannelIds(msgs.map((m) => m.channel_id));
    expect(msgs.every((m) => pub.has(m.channel_id))).toBe(true); // channel_types=public_channel holds

    const ctx = { threadId: 'CLIVE:1.1', channelId: 'CLIVE', threadTs: '1.1', speakerId: 'U0LIVERTS', turnId: 1, extras: {} };
    const out: string = await (toolsFor('child', ctx).slack_semantic_search as any).execute({ query: 'what is happening this week?' }, { toolCallId: 't', messages: [] });
    console.log('tool output:', out.slice(0, 2000));
    expect(out).toMatch(/public channels only|No public-channel results/);
    for (const id of out.matchAll(/<#([A-Z0-9]+)\|/g)) expect(pub.has(id[1]!) || (await publicChannelIds([id[1]!])).has(id[1]!)).toBe(true);
  }, 60_000);
});
