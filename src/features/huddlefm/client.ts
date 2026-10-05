/**
 * Talking to HuddleFM: commands are posted into the bot's DM with the HuddleFM user (through the one Slack client),
 * replies come back as threaded DMs that ingress delivers like any message event, to whichever worker takes it.
 *
 * So nothing waits in memory: inbound.ts stores each reply in Redis under the command's ts (`replyTo`), and the sender
 * polls that key. A reply that lands before chat.postMessage has even returned is simply already there. Replies are
 * kept for a while, so an idempotent re-send (same key → Slack isn't called again, same ts) still finds its answer.
 *
 * Never call this from the slack-events processor: the replies it waits for arrive through that same queue.
 */
import { env, limits } from '../../config.js';
import { redis } from '../../core/redis.js';
import { slackCall } from '../../core/slack.js';
import { log } from '../../log.js';
import { encodeCommand, type HfmCommand, type HfmMessage } from './protocol.js';

const DM_KEY = 'hfm:dm';
const replyKey = (ts: string) => `hfm:reply:${ts}`;
const REPLY_TTL_S = 30 * 60;

export const huddleFmConfigured = () => Boolean(env.HUDDLEFM_USER_ID);

/** The bot's DM channel with the HuddleFM user (cached; conversations.open is idempotent anyway). */
export async function huddleFmDm(): Promise<string> {
  const cached = await redis.get(DM_KEY);
  if (cached) return cached;
  if (!env.HUDDLEFM_USER_ID) throw new Error('HuddleFM is not configured (HUDDLEFM_USER_ID)');
  const res = await slackCall<any>('conversations.open', { users: env.HUDDLEFM_USER_ID });
  const id: string | undefined = res.channel?.id;
  if (!id) throw new Error('could not open a DM with HuddleFM');
  await redis.set(DM_KEY, id, 'EX', 24 * 60 * 60);
  return id;
}

/** Inbound side: a threaded reply from HuddleFM for the command posted at `replyTo`. */
export async function storeReply(replyTo: string, reply: HfmMessage): Promise<void> {
  await redis.set(replyKey(replyTo), JSON.stringify(reply), 'EX', REPLY_TTL_S);
}

export async function waitForReply(ts: string, timeoutMs: number): Promise<HfmMessage | null> {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 100; ; delay = Math.min(delay * 1.5, 500)) {
    const raw = await redis.get(replyKey(ts));
    if (raw) return JSON.parse(raw) as HfmMessage;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise((r) => setTimeout(r, Math.min(delay, left)));
  }
}

export interface SendOpts {
  /** Side effects: derived from the triggering turn / tool call / job, so a retry doesn't run a command twice. */
  idempotencyKey?: string;
  /** How long to wait for the threaded reply (default limits.djReplyTimeoutMs). */
  timeoutMs?: number;
  /** Called with the command's ts as soon as it is posted, before waiting (e.g. to record a request). */
  onSent?: (ts: string) => Promise<void>;
}

/** Post one command and wait for its reply (null: no reply in time). */
export async function sendCommand(cmd: HfmCommand, opts: SendOpts = {}): Promise<{ ts: string; reply: HfmMessage | null }> {
  const channel = await huddleFmDm();
  const posted = await slackCall<any>(
    'chat.postMessage',
    { channel, text: encodeCommand(cmd), unfurl_links: false, unfurl_media: false },
    opts.idempotencyKey ? { idempotencyKey: `hfm:${opts.idempotencyKey}` } : {},
  );
  const ts: string | undefined = posted.ts ?? posted.message?.ts;
  if (!ts) throw new Error('posting the HuddleFM command returned no ts');
  if (opts.onSent) await opts.onSent(ts);
  const reply = await waitForReply(ts, opts.timeoutMs ?? limits.djReplyTimeoutMs);
  log.debug({ type: cmd.type, channel: cmd.channel, ts, ok: reply?.ok, error: reply?.error }, 'huddlefm command');
  return { ts, reply };
}
