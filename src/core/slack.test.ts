/**
 * slackCall's 429 handling, run against the fake through the shared limiter (SLACK_FAKE_LIMITER=1): a 429 pauses
 * only the token kind that got it.
 */
import '../tools/test-env.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { redis } from './redis.js';
import { addFakeHandler } from './slack-fake.js';
import { pauseKey, slackCall, SlackBusyError } from './slack.js';

const METHOD = 'conversations.replies';
const CHANNEL = 'C429TEST';
let pending429 = 0;
let retryAfter = 2;
let served: string[] = [];

const remove = addFakeHandler((method, args, token) => {
  if (method !== METHOD || args.channel !== CHANNEL) return undefined;
  if (token === 'user' && pending429 > 0) {
    pending429--;
    // What @slack/web-api throws with rejectRateLimitedCalls (retryAfter in seconds).
    throw Object.assign(new Error('A rate limit was exceeded'), { code: 'slack_webapi_rate_limited_error', retryAfter });
  }
  served.push(token);
  return { ok: true, messages: [] };
});

const prevLimiter = process.env.SLACK_FAKE_LIMITER;
process.env.SLACK_FAKE_LIMITER = '1';

beforeEach(async () => {
  pending429 = 0;
  retryAfter = 2;
  served = [];
  await redis.del(pauseKey('user', METHOD), pauseKey('bot', METHOD));
});

afterAll(async () => {
  remove();
  if (prevLimiter === undefined) delete process.env.SLACK_FAKE_LIMITER;
  else process.env.SLACK_FAKE_LIMITER = prevLimiter;
  await redis.del(pauseKey('user', METHOD), pauseKey('bot', METHOD));
  await sql.end();
});

describe('429 backoff', () => {
  it("a 429 on the user token pauses that token only, not the bot token's calls to the same method", async () => {
    pending429 = 1;
    await expect(slackCall(METHOD, { channel: CHANNEL, ts: '1.1' }, { token: 'user', maxWaitMs: 200 })).rejects.toBeInstanceOf(SlackBusyError);
    expect(await redis.exists(pauseKey('user', METHOD))).toBe(1);
    expect(await redis.exists(pauseKey('bot', METHOD))).toBe(0);

    // The bot token isn't held back by the user token's pause.
    const started = Date.now();
    await slackCall(METHOD, { channel: CHANNEL, ts: '1.1' }, { maxWaitMs: 200 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(served).toEqual(['bot']);

    // The user token still is (fails fast instead of calling Slack during the pause).
    await expect(slackCall(METHOD, { channel: CHANNEL, ts: '1.1' }, { token: 'user', maxWaitMs: 200 })).rejects.toBeInstanceOf(SlackBusyError);
    expect(served).toEqual(['bot']);
  });

  it('waits out a short 429 and retries', async () => {
    pending429 = 1;
    retryAfter = 0.2;
    await slackCall(METHOD, { channel: CHANNEL, ts: '1.1' }, { token: 'user' });
    expect(served).toEqual(['user']);
  });
});

describe('quiet Slack warnings', () => {
  it('only the expected missing-subscription warning is quiet', async () => {
    const { isQuietSlackWarning } = await import('./slack.js');
    expect(isQuietSlackWarning(['missing_agent_session_stopped_event_subscription'])).toBe(true);
    expect(isQuietSlackWarning(['agents.sessions.setStatus warning: missing_agent_session_stopped_event_subscription'])).toBe(true);
    expect(isQuietSlackWarning(['missing_charset'])).toBe(false);
    expect(isQuietSlackWarning([{ x: 1 }])).toBe(false);
  });
});
