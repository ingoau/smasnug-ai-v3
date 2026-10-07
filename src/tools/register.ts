// Module registration: importing this registers tools/actions. The worker wires processors and maintenance.
import type { Job } from 'bullmq';
import { QUEUE, type QueueName } from '../core/queues.js';
import { processThreadSummary, type ThreadSummaryJob } from '../context/summary.js';

// Tool registrations (side-effect imports).
import './fetch-url.js';
import './web-search.js';
import './slack-search.js';
import './read-history.js';
import './public-thread.js';
import './ask-thread.js';
import './public-channel.js';
import '../files/tools.js';
import './emoji.js';
import './canvases.js';
import './directory/tools.js';
import { pruneImageCache } from '../files/images.js';
import { ensureDirectoryCrawl, processCrawlPage, type CrawlPageJob } from './directory/crawl.js';
import { log } from '../log.js';

export const processors: Partial<Record<QueueName, (job: Job) => Promise<void>>> = {
  [QUEUE.threadSummary]: async (job) => {
    await processThreadSummary(job.data as ThreadSummaryJob);
  },
  [QUEUE.directory]: async (job) => {
    await processCrawlPage(job as Job<CrawlPageJob>);
  },
};

/** Periodic tasks run via the `maintenance` queue: { [taskName]: { everyMs, run } }. */
export const maintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = {
  'tools:image-cache-prune': { everyMs: 6 * 60 * 60 * 1000, run: async () => void (await pruneImageCache(7 * 24 * 60 * 60 * 1000)) },
  // Weekly directory re-crawl (due after limits.directoryRecrawlAfterMs) and resuming a stalled crawl.
  'tools:directory-crawl': { everyMs: 60 * 60 * 1000, run: () => ensureDirectoryCrawl() },
};

/** Worker start: build the directory if it's empty or stale, and continue a crawl a restart interrupted. */
export async function onStart(): Promise<void> {
  await ensureDirectoryCrawl({ resumeRunning: true }).catch((err) => log.error({ err }, 'directory crawl start failed'));
}

/** Called on SIGTERM before the worker exits. */
export async function onShutdown(): Promise<void> {}
