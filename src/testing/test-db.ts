/**
 * Test infrastructure targets. Tests NEVER use the dev database / Redis from `.env`: every vitest process points
 * DATABASE_URL / REDIS_URL at TEST_DATABASE_URL / TEST_REDIS_URL (defaults: the `smasnug_test` database and Redis
 * db 9 on the same servers as `.env`) and forces SLACK_FAKE=1. Wired in `vitest.config.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const TEST_DB_NAME = 'smasnug_test';
export const TEST_REDIS_DB = 9;

const DEFAULT_DB = 'postgres://smasnug:smasnug@localhost:5433/smasnug';
const DEFAULT_REDIS = 'redis://localhost:6380';

/** DATABASE_URL / REDIS_URL from `.env` (not loaded into process.env), falling back to the app defaults. */
function devTargets(): { db: string; redis: string } {
  let file: Record<string, string | undefined> = {};
  if (existsSync('.env')) {
    try {
      file = parseEnv(readFileSync('.env', 'utf8'));
    } catch {}
  }
  return { db: file.DATABASE_URL ?? DEFAULT_DB, redis: file.REDIS_URL ?? DEFAULT_REDIS };
}

function dbKey(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || 5432}${u.pathname}`;
}

/** True if `url` is the dev Redis db from `.env` (tests must never flush it). */
export function isDevRedis(url: string): boolean {
  return redisKey(url) === redisKey(devTargets().redis);
}

function redisKey(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || 6379}/${u.pathname.replace(/^\//, '') || '0'}`;
}

export function resolveTestTargets(): { databaseUrl: string; redisUrl: string } {
  const dev = devTargets();
  const databaseUrl =
    process.env.TEST_DATABASE_URL ||
    (() => {
      const u = new URL(dev.db);
      u.pathname = `/${TEST_DB_NAME}`;
      return u.toString();
    })();
  const redisUrl =
    process.env.TEST_REDIS_URL ||
    (() => {
      const u = new URL(dev.redis);
      u.pathname = `/${TEST_REDIS_DB}`;
      return u.toString();
    })();
  assertNotDev(databaseUrl, redisUrl);
  return { databaseUrl, redisUrl };
}

function assertNotDev(databaseUrl: string, redisUrl: string): void {
  const dev = devTargets();
  if (dbKey(databaseUrl) === dbKey(dev.db)) throw new Error(`TEST_DATABASE_URL points at the dev database (${dbKey(dev.db)}); refusing to run tests against it.`);
  if (redisKey(redisUrl) === redisKey(dev.redis)) throw new Error(`TEST_REDIS_URL points at the dev Redis db (${redisKey(dev.redis)}); refusing to run tests against it.`);
}

export const BENCH_DB_NAME = 'smasnug_bench';
export const BENCH_REDIS_DB = 11;

/**
 * `pnpm bench`: same isolation as the tests, but its own database (`smasnug_bench`) and Redis db (11) on the test
 * servers, so a benchmark never collides with a concurrent test run (which flushes the test Redis db).
 */
export function applyBenchEnv(): { databaseUrl: string; redisUrl: string } {
  const t = resolveTestTargets();
  const db = new URL(t.databaseUrl);
  db.pathname = `/${BENCH_DB_NAME}`;
  const r = new URL(t.redisUrl);
  r.pathname = `/${BENCH_REDIS_DB}`;
  const out = { databaseUrl: db.toString(), redisUrl: r.toString() };
  assertNotDev(out.databaseUrl, out.redisUrl);
  process.env.DATABASE_URL = out.databaseUrl;
  process.env.REDIS_URL = out.redisUrl;
  process.env.SLACK_FAKE = '1';
  return out;
}

/** Point this process at the test infra (call before any app module reads env). */
export function applyTestEnv(): void {
  const { databaseUrl, redisUrl } = resolveTestTargets();
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.SLACK_FAKE = '1';
}
