/**
 * SLACK_FAKE=1: no network. Every call is appended to the Redis list `slack:fake:calls` (JSON) and answered with a
 * plausible response, so the whole pipeline can be exercised locally against real models. Any module may add cases.
 */
import { redis } from './redis.js';

let counter = 0;

/**
 * Test/dev hook: handlers run before the built-in cases; the first one returning non-undefined wins. A handler may
 * throw `fakeSlackError('invalid_name')` to simulate a Slack API error. Returns a function that removes the handler.
 */
export type FakeHandler = (method: string, args: Record<string, unknown>, token: string) => any;
const handlers: FakeHandler[] = [];
export function addFakeHandler(h: FakeHandler): () => void {
  handlers.push(h);
  return () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** An error shaped like @slack/web-api's platform error (`slackErrorCode(err)` reads `data.error`). */
export function fakeSlackError(code: string) {
  return Object.assign(new Error(`An API error occurred: ${code}`), { code: 'slack_webapi_platform_error', data: { ok: false, error: code } });
}
const nextTs = () => `${Math.floor(Date.now() / 1000)}.${String(++counter).padStart(6, '0')}`;

export async function fakeCall(method: string, args: Record<string, unknown>, token: string): Promise<any> {
  await redis.rpush('slack:fake:calls', JSON.stringify({ at: Date.now(), method, token, args }));
  for (const h of handlers) {
    const res = await h(method, args, token);
    if (res !== undefined) return res;
  }
  switch (method) {
    case 'auth.test':
      return { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'TFAKE' };
    case 'chat.postMessage':
    case 'chat.startStream':
    case 'chat.postEphemeral':
      return { ok: true, channel: args.channel, ts: nextTs(), message_ts: nextTs() };
    case 'chat.update':
    case 'chat.appendStream':
    case 'chat.stopStream':
      return { ok: true, channel: args.channel, ts: args.ts };
    case 'chat.getPermalink':
      return { ok: true, permalink: `https://fake.slack.com/archives/${args.channel}/p${String(args.message_ts).replace('.', '')}` };
    case 'users.info': {
      const id = String(args.user);
      return { ok: true, user: { id, name: id.toLowerCase(), real_name: `User ${id}`, tz: 'Europe/Berlin', is_bot: false, profile: { display_name: `User ${id}`, image_192: 'https://example.com/a.png' } } };
    }
    case 'conversations.replies':
    case 'conversations.history':
      return { ok: true, messages: [], has_more: false };
    case 'conversations.info':
      return { ok: true, channel: { id: args.channel, name: 'fake-channel', is_private: false, creator: 'UADMIN', is_member: true } };
    case 'conversations.list':
      return {
        ok: true,
        channels: [
          { id: 'CGENERAL', name: 'general', is_private: false, is_member: true },
          { id: 'CRANDOM', name: 'random', is_private: false, is_member: false },
        ],
        response_metadata: { next_cursor: '' },
      };
    case 'conversations.members':
      return { ok: true, members: ['UADMIN', 'UBOT'], response_metadata: { next_cursor: '' } };
    case 'conversations.join':
      return { ok: true, channel: { id: args.channel } };
    case 'chat.delete':
      return { ok: true, channel: args.channel, ts: args.ts };
    case 'conversations.open':
      return { ok: true, channel: { id: `D${String(args.users)}` } };
    case 'search.messages':
      return { ok: true, messages: { matches: [], total: 0 } };
    case 'files.getUploadURLExternal':
      return { ok: true, upload_url: 'https://fake.invalid/upload', file_id: `F${++counter}` };
    default:
      return { ok: true };
  }
}

export async function fakeCalls(): Promise<{ method: string; args: any }[]> {
  return (await redis.lrange('slack:fake:calls', 0, -1)).map((s) => JSON.parse(s));
}
