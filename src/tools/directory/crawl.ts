/**
 * Directory crawl: users.list (people) and conversations.list (public channels, archived included) page by page,
 * one `directory` queue job per page, paced at `limits.directoryCrawlPageIntervalMs` and run at `background`
 * priority through the shared Slack limiter. The cursor lives in `directory_crawls`, so a restart continues where
 * it stopped; upserts are idempotent and a duplicate page job is dropped (the page counter must match). A complete
 * crawl deletes the rows it didn't see (users / channels gone from Slack).
 *
 * Started on worker start when a kind was never crawled or its last complete crawl is older than
 * `limits.directoryRecrawlAfterMs` (7 days), and re-checked hourly by a maintenance task (the weekly re-crawl, and
 * resuming a crawl whose jobs were lost).
 */
import type { Job } from 'bullmq';
import { limits } from '../../config.js';
import { enqueue, QUEUE } from '../../core/queues.js';
import { slackCall, slackErrorCode } from '../../core/slack.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { channelFromSlack, personFromSlack, type DirectoryChannel, type DirectoryPerson } from './fields.js';
import { deleteChannelsNotSyncedSince, deletePeopleNotSyncedSince, upsertChannels, upsertPeople } from './store.js';

export type CrawlKind = 'people' | 'channels';
export const CRAWL_KINDS: CrawlKind[] = ['people', 'channels'];

export interface CrawlPageJob {
  type: 'page';
  kind: CrawlKind;
  /** The crawl's started_at (ms): a job of an older crawl is dropped. */
  startedAt: number;
  /** Pages already done when this job was queued: must match the stored counter. */
  page: number;
}

export interface CrawlState {
  kind: CrawlKind;
  running: boolean;
  startedAt: Date | null;
  cursor: string | null;
  pages: number;
  rowsSeen: number;
  progressAt: Date | null;
  finishedAt: Date | null;
  lastTotal: number | null;
}

/** A running crawl without progress for this long is resumed by the hourly check. */
const STALLED_MS = 10 * 60_000;
/** A crawl that saw fewer rows than this share of the last complete one doesn't delete unseen rows (Slack hiccup). */
const MIN_SHARE_FOR_PRUNE = 0.5;

export async function crawlState(kind: CrawlKind): Promise<CrawlState | null> {
  const [row] = await sql<CrawlState[]>`select * from directory_crawls where kind = ${kind}`;
  return row ?? null;
}

/** Progress of a kind: null once a crawl has completed (the directory is usable), else percent done (0–99). */
export function buildingPercent(state: Pick<CrawlState, 'finishedAt' | 'rowsSeen' | 'lastTotal' | 'running'> | null, estimate: number): number | null {
  if (state?.finishedAt) return null;
  if (!state?.running) return 0;
  const total = state.lastTotal || estimate;
  return Math.min(99, Math.floor((100 * state.rowsSeen) / Math.max(1, total)));
}

function jobId(kind: CrawlKind, startedAt: number, page: number, retry?: number) {
  return `dir-${kind}-${startedAt}-${page}${retry ? `-r${retry}` : ''}`;
}

async function queuePage(kind: CrawlKind, startedAt: number, page: number, opts: { delayMs?: number; retry?: number } = {}) {
  const data: CrawlPageJob = { type: 'page', kind, startedAt, page };
  await enqueue(QUEUE.directory, data, {
    jobId: jobId(kind, startedAt, page, opts.retry),
    delay: opts.delayMs ?? 0,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
  });
}

/** Start a new crawl of `kind` unless one is running. Returns true if it started one. */
export async function startCrawl(kind: CrawlKind): Promise<boolean> {
  // started_at at millisecond precision: jobs carry it as JS ms and the updates below match on it.
  const rows = await sql<{ startedAt: Date }[]>`
    insert into directory_crawls (kind, running, started_at, cursor, pages, rows_seen, progress_at)
    values (${kind}, true, date_trunc('milliseconds', now()), '', 0, 0, now())
    on conflict (kind) do update set running = true, started_at = date_trunc('milliseconds', now()), cursor = '', pages = 0, rows_seen = 0, progress_at = now()
    where not directory_crawls.running
    returning started_at`;
  if (!rows[0]) return false;
  log.info({ kind }, 'directory crawl started');
  await queuePage(kind, rows[0].startedAt.getTime(), 0);
  return true;
}

/**
 * Start what's due and resume what's stuck. `resumeRunning`: re-queue every running crawl's next page right away
 * (worker start: its queued job may be gone); otherwise only crawls without progress for STALLED_MS.
 */
export async function ensureDirectoryCrawl(opts: { resumeRunning?: boolean; now?: number } = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  for (const kind of CRAWL_KINDS) {
    const st = await crawlState(kind);
    if (st?.running && st.startedAt) {
      const stalled = !st.progressAt || now - st.progressAt.getTime() > STALLED_MS;
      if (opts.resumeRunning || stalled) {
        log.info({ kind, page: st.pages }, 'directory crawl resumed');
        await queuePage(kind, st.startedAt.getTime(), st.pages, { retry: now });
      }
      continue;
    }
    if (!st?.finishedAt || now - st.finishedAt.getTime() > limits.directoryRecrawlAfterMs) await startCrawl(kind);
  }
}

interface Page<T> {
  rows: T[];
  next: string;
}

async function fetchPage(kind: 'people', cursor: string): Promise<Page<DirectoryPerson>>;
async function fetchPage(kind: 'channels', cursor: string): Promise<Page<DirectoryChannel>>;
async function fetchPage(kind: CrawlKind, cursor: string): Promise<Page<DirectoryPerson | DirectoryChannel>> {
  if (kind === 'people') {
    const res = await slackCall<any>(
      'users.list',
      { limit: limits.directoryUsersPageSize, include_locale: true, ...(cursor ? { cursor } : {}) },
      { priority: 'background' },
    );
    const members: any[] = Array.isArray(res.members) ? res.members : [];
    return { rows: members.map(personFromSlack).filter((p): p is DirectoryPerson => !!p), next: res.response_metadata?.next_cursor ?? '' };
  }
  const res = await slackCall<any>(
    'conversations.list',
    { types: 'public_channel', exclude_archived: false, limit: limits.directoryChannelsPageSize, ...(cursor ? { cursor } : {}) },
    { priority: 'background' },
  );
  const channels: any[] = Array.isArray(res.channels) ? res.channels : [];
  // channelFromSlack drops anything not positively public.
  return { rows: channels.map(channelFromSlack).filter((c): c is DirectoryChannel => !!c), next: res.response_metadata?.next_cursor ?? '' };
}

/** One page of a crawl (the `directory` queue processor). */
export async function processCrawlPage(job: Pick<Job<CrawlPageJob>, 'data'>): Promise<void> {
  const { kind, startedAt, page } = job.data;
  const st = await crawlState(kind);
  if (!st?.running || !st.startedAt || st.startedAt.getTime() !== startedAt || st.pages !== page) {
    log.debug({ kind, page, state: st }, 'directory crawl page dropped: stale or duplicate');
    return;
  }
  let res: Page<DirectoryPerson | DirectoryChannel>;
  try {
    res = kind === 'people' ? await fetchPage('people', st.cursor ?? '') : await fetchPage('channels', st.cursor ?? '');
  } catch (err) {
    if (slackErrorCode(err) === 'invalid_cursor') {
      // The cursor expired (a long pause): start this crawl over.
      log.warn({ kind, page }, 'directory crawl cursor expired; restarting the crawl');
      await sql`update directory_crawls set running = false where kind = ${kind} and started_at = ${st.startedAt}`;
      await startCrawl(kind);
      return;
    }
    throw err; // BullMQ retries with backoff; the hourly check resumes it after that
  }
  if (kind === 'people') await upsertPeople(res.rows as DirectoryPerson[], { touch: true });
  else await upsertChannels(res.rows as DirectoryChannel[], { touch: true });

  if (res.next) {
    const advanced = await sql`
      update directory_crawls set cursor = ${res.next}, pages = pages + 1, rows_seen = rows_seen + ${res.rows.length}, progress_at = now()
      where kind = ${kind} and running and started_at = ${st.startedAt} and pages = ${page}`;
    if (advanced.count) await queuePage(kind, startedAt, page + 1, { delayMs: limits.directoryCrawlPageIntervalMs });
    return;
  }
  await finishCrawl(st, res.rows.length);
}

async function finishCrawl(st: CrawlState, lastPageRows: number): Promise<void> {
  const seen = st.rowsSeen + lastPageRows;
  const done = await sql`
    update directory_crawls set running = false, cursor = null, pages = pages + 1, rows_seen = ${seen}, progress_at = now(),
      finished_at = now(), last_total = ${seen}
    where kind = ${st.kind} and running and started_at = ${st.startedAt} and pages = ${st.pages}`;
  if (!done.count) return;
  let pruned = 0;
  if (st.lastTotal && seen < st.lastTotal * MIN_SHARE_FOR_PRUNE) {
    log.warn({ kind: st.kind, seen, lastTotal: st.lastTotal }, 'directory crawl saw far fewer rows than last time; not deleting unseen rows');
  } else {
    // Rows not confirmed since this crawl started are gone from Slack (deleted users, deleted channels).
    pruned = st.kind === 'people' ? await deletePeopleNotSyncedSince(st.startedAt!) : await deleteChannelsNotSyncedSince(st.startedAt!);
  }
  log.info({ kind: st.kind, rows: seen, pages: st.pages + 1, pruned }, 'directory crawl finished');
}
