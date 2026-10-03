import { hostname } from 'node:os';

/** Unique id of this worker process (e.g. for runs.worker_id and heartbeats). */
export const WORKER_ID = `${hostname()}:${process.pid}`;
