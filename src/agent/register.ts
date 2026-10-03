// Module registration: importing this registers tools/actions. The worker wires processors and maintenance.
import type { Job } from 'bullmq';
import type { QueueName } from '../core/queues.js';

export const processors: Partial<Record<QueueName, (job: Job) => Promise<void>>> = {};

/** Periodic tasks run via the `maintenance` queue: { [taskName]: { everyMs, run } }. */
export const maintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = {};

/** Called on SIGTERM before the worker exits. */
export async function onShutdown(): Promise<void> {}
