import { Redis } from 'ioredis';
import { env } from '../config.js';

/** General-purpose client (rate limiter, locks, short-lived coordination). */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

/** BullMQ needs maxRetriesPerRequest: null; create one per Queue/Worker. */
export const bullConnection = () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
