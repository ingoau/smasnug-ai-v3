/** Redis locks: token + TTL, renewal while held, compare-and-delete release. */
import { randomUUID } from 'node:crypto';
import { redis } from '../core/redis.js';
import { log } from '../log.js';

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

export interface HeldLock {
  key: string;
  token: string;
  /** False once a renewal found the lock gone/stolen. */
  readonly held: boolean;
  release(): Promise<void>;
}

export async function acquireLock(key: string, ttlMs: number, renewEveryMs = Math.floor(ttlMs / 3)): Promise<HeldLock | null> {
  const token = randomUUID();
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  let held = true;
  let released = false;
  const timer = setInterval(async () => {
    try {
      const r = (await redis.eval(RENEW, 1, key, token, ttlMs)) as number;
      if (r !== 1 && !released) {
        held = false;
        clearInterval(timer);
        log.warn({ key }, 'lock lost before release');
      }
    } catch (err) {
      log.warn({ err, key }, 'lock renewal failed');
    }
  }, renewEveryMs);
  timer.unref();
  return {
    key,
    token,
    get held() {
      return held;
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await redis.eval(RELEASE, 1, key, token);
    },
  };
}

export const threadLockKey = (threadId: string) => `lock:thread:${threadId}`;
export const THREAD_LOCK_TTL_MS = 60_000;

export async function isLocked(key: string): Promise<boolean> {
  return (await redis.exists(key)) === 1;
}
