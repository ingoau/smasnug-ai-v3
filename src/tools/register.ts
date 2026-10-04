// Module registration: importing this registers tools/actions. The worker wires processors and maintenance.
import type { Job } from 'bullmq';
import type { QueueName } from '../core/queues.js';

// Tool registrations (side-effect imports).
import './fetch-url.js';
import './web-search.js';
import './slack-search.js';
import './slack-semantic-search.js';
import './read-history.js';
import './public-thread.js';
import './read-image.js';
import './emoji.js';
import './canvases.js';
import { pruneImageCache } from './read-image.js';

export const processors: Partial<Record<QueueName, (job: Job) => Promise<void>>> = {};

/** Periodic tasks run via the `maintenance` queue: { [taskName]: { everyMs, run } }. */
export const maintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = {
  'tools:image-cache-prune': { everyMs: 6 * 60 * 60 * 1000, run: async () => void (await pruneImageCache(7 * 24 * 60 * 60 * 1000)) },
};

/** Called on SIGTERM before the worker exits. */
export async function onShutdown(): Promise<void> {}
