/**
 * The automatic Status tab (docs/code-channels.md, Status tab): a Block Kit view under the reserved view_key
 * `status`, rendered from DB state by code (status-view.ts) and kept up to date:
 * - right after a channel is created or adopted (open.ts, adopt.ts: `refreshCodeChannelStatus`, after setCommands);
 * - whenever a plan card in the channel re-renders (src/agent/cards.ts renderCardNow), which every run start,
 *   progress step, finish, failure and cancel goes through;
 * - at the end of each turn in it (src/pipeline/thread-run.ts), and when the sweep warns it.
 * Those call `requestCodeChannelStatus`, which coalesces bursts into one delayed `code-channel-status` job per
 * channel (a Redis flag, like the card renders). The refresh skips the setView when the blocks are the same as last
 * time (times are Slack date tokens, so they don't change by themselves). Archived channels and a switched-off
 * feature are skipped. Never throws: failures are logged.
 */
import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { limits } from '../../config.js';
import { enqueue, QUEUE } from '../../core/queues.js';
import { redis } from '../../core/redis.js';
import { slackCall } from '../../core/slack.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { setCodeChannelView } from './api.js';
import { codeChannelsConfigured, codeChannelsEnabled } from './settings.js';
import { renderStatusBlocks, runKindLabel, STATUS_MAX_ACTIVE, STATUS_MAX_FINISHED, STATUS_VIEW_KEY, STATUS_VIEW_NAME, type StatusInput, type StatusRun, type StatusRunState } from './status-view.js';
import { getCodeChannel, isCodeChannel, type CodeChannel } from './store.js';

/** Bursts within this window make one setView. */
export const STATUS_DEBOUNCE_MS = 3_000;
const pendingKey = (ch: string) => `cc-status:pending:${ch}`;
const hashKey = (ch: string) => `cc-status:hash:${ch}`;
const lockKey = (ch: string) => `cc-status:lock:${ch}`;
const originKey = (ch: string) => `cc-status:origin:${ch}`;
/** The last pushed blocks' hash is kept this long: after that the tab is pushed again even if unchanged. */
const HASH_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Something in this channel changed: refresh its Status tab soon (coalesced per channel). Takes a channel id or a
 * thread id (`C…:ts`). Cheap for ordinary channels (the cached isCodeChannel). Never throws.
 */
export async function requestCodeChannelStatus(channelOrThreadId: string): Promise<void> {
  const channelId = channelOrThreadId.split(':')[0]!;
  try {
    if (!codeChannelsConfigured() || !channelId) return;
    if (!(await isCodeChannel(channelId))) return;
    if (!(await codeChannelsEnabled())) return;
    const set = await redis.set(pendingKey(channelId), '1', 'PX', 60_000, 'NX');
    if (!set) return; // a refresh is already scheduled and will read the latest state
    await enqueue(QUEUE.codeChannelStatus, { channelId }, { delay: STATUS_DEBOUNCE_MS });
  } catch (err) {
    log.warn({ err, channelId }, 'requestCodeChannelStatus failed');
  }
}

/** Processor for `code-channel-status` jobs: { channelId }. */
export async function processCodeChannelStatus(job: Job): Promise<void> {
  const channelId = String(job.data?.channelId ?? '');
  if (!channelId) return;
  await redis.del(pendingKey(channelId)).catch(() => {});
  await refreshCodeChannelStatus(channelId);
}

interface RunRow {
  title: string;
  sandbox: boolean | null;
  kind: string | null;
  status: StatusRunState;
  cancelRequested: boolean;
  startedAt: Date | null;
  createdAt: Date;
  finishedAt: Date | null;
  threadId: string;
}

const toRun = (r: RunRow): StatusRun => ({
  title: r.title,
  kind: runKindLabel(r),
  status: r.status,
  cancelRequested: r.cancelRequested,
  startedAt: r.startedAt,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
  inThread: !r.threadId.endsWith(':0'),
});

/** The origin message's permalink, cached (it never changes). */
async function originPermalink(row: CodeChannel): Promise<string | null> {
  if (!row.originChannelId || !row.originTs) return null;
  const cached = await redis.get(originKey(row.channelId)).catch(() => null);
  if (cached) return cached;
  const link = await slackCall<any>('chat.getPermalink', { channel: row.originChannelId, message_ts: row.originTs })
    .then((r) => (typeof r?.permalink === 'string' ? (r.permalink as string) : null))
    .catch(() => null);
  if (link) await redis.set(originKey(row.channelId), link, 'PX', 7 * 24 * 60 * 60 * 1000).catch(() => {});
  return link;
}

/** Everything the tab shows (DB reads + one cached permalink lookup). */
export async function loadStatusInput(row: CodeChannel): Promise<StatusInput> {
  const ch = row.channelId;
  const runCols = sql`s.title, s.sandbox, s.kind, r.status, r.cancel_requested, r.started_at, r.created_at, r.finished_at, r.thread_id`;
  const [active, finished, [thread], [sends], permalink] = await Promise.all([
    sql<RunRow[]>`
      select ${runCols} from runs r join subagents s on s.id = r.subagent_id
      where split_part(r.thread_id, ':', 1) = ${ch} and r.status in ('queued', 'running')
      order by r.id desc limit ${STATUS_MAX_ACTIVE + 1}`,
    sql<RunRow[]>`
      select ${runCols} from runs r join subagents s on s.id = r.subagent_id
      where split_part(r.thread_id, ':', 1) = ${ch} and r.status in ('complete', 'error', 'cancelled')
      order by r.finished_at desc nulls last, r.id desc limit ${STATUS_MAX_FINISHED}`,
    sql<{ awaitsReplyFrom: string | null }[]>`select awaits_reply_from from threads where id = ${row.threadId}`,
    sql<{ n: number }[]>`
      select count(*)::int as n from pending_sends
      where split_part(thread_id, ':', 1) = ${ch} and status = 'pending' and expires_at > now()`,
    originPermalink(row),
  ]);
  const idleArchive = new Date(row.lastActivityAt.getTime() + limits.codeChannelArchiveMs);
  const archivesAt = row.warnedAt ? new Date(Math.max(idleArchive.getTime(), row.warnedAt.getTime() + limits.codeChannelArchiveMs - limits.codeChannelWarnMs)) : idleArchive;
  return {
    kind: row.kind,
    brief: row.brief,
    originPermalink: permalink,
    openedBy: row.createdBy ?? row.requesterId,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    warnedAt: row.warnedAt,
    archivesAt,
    waitingOn: thread?.awaitsReplyFrom ?? null,
    pendingConfirmations: sends?.n ?? 0,
    active: active.map(toRun),
    finished: finished.map(toRun),
  };
}

/**
 * Render and push the Status tab now (skipped when the blocks didn't change since the last push, the channel is
 * archived or not a code channel, or the feature is off). Never throws.
 */
export async function refreshCodeChannelStatus(channelId: string): Promise<void> {
  let token: string | null = null;
  try {
    if (!(await codeChannelsEnabled())) return;
    token = Math.random().toString(36).slice(2);
    const got = await redis.set(lockKey(channelId), token, 'PX', 15_000, 'NX');
    if (!got) {
      token = null;
      await requestCodeChannelStatus(channelId); // someone is refreshing now: make sure another follows theirs
      return;
    }
    const row = await getCodeChannel(channelId);
    if (!row || row.archivedAt) return;
    const blocks = renderStatusBlocks(await loadStatusInput(row));
    const hash = createHash('sha256').update(JSON.stringify(blocks)).digest('hex').slice(0, 24);
    if ((await redis.get(hashKey(channelId))) === hash) return;
    await setCodeChannelView(channelId, { type: 'block_kit', viewKey: STATUS_VIEW_KEY, name: STATUS_VIEW_NAME, blocks });
    await redis.set(hashKey(channelId), hash, 'PX', HASH_TTL_MS);
  } catch (err) {
    log.warn({ err, channelId }, 'code channel status tab refresh failed');
  } finally {
    if (token) {
      await redis
        .eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`, 1, lockKey(channelId), token)
        .catch(() => {});
    }
  }
}
