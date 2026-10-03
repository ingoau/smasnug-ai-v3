/**
 * Integration-test setup: points the app at a dedicated test database (`<db>_test`) and Redis db, creating and
 * migrating it. Must run BEFORE any app module is imported (they read env at import time), so tests import app
 * modules dynamically after calling this.
 */
import { existsSync } from 'node:fs';
import postgres from 'postgres';
import { Redis } from 'ioredis';

export const TEST_REDIS_DB = 12;

/**
 * `name` / `redisDb`: each integration test file gets its own database (`smasnug_<name>_test`) and Redis db, so
 * files can run in parallel. With an explicit TEST_DATABASE_URL / TEST_REDIS_URL (e.g. a second checkout running
 * tests concurrently) they are derived from those instead: database `<test db>_<name>`, Redis db `<test db> +
 * redisOffset`, so concurrent checkouts don't collide either.
 */
export async function setupTestInfra(opts: { name?: string; redisDb?: number; redisOffset?: number } = {}): Promise<boolean> {
  const name = opts.name ?? 'pipeline';
  if (existsSync('.env')) process.loadEnvFile('.env');
  process.env.OPENROUTER_KEY ||= 'test';
  const base = new URL(process.env.DATABASE_URL ?? 'postgres://smasnug:smasnug@localhost:5433/smasnug');
  const explicitDb = process.env.TEST_DATABASE_URL ? decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).pathname.replace(/^\//, '')) : '';
  const dbName = explicitDb ? `${explicitDb}_${name}` : `smasnug_${name}_test`;
  const admin = postgres({ host: base.hostname, port: Number(base.port || 5432), user: base.username, password: base.password, database: 'postgres', max: 1, onnotice: () => {}, connect_timeout: 2 });
  try {
    const exists = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (exists.length === 0) await admin.unsafe(`create database "${dbName}"`);
  } catch {
    return false;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
  const testUrl = new URL(base);
  testUrl.pathname = `/${dbName}`;
  process.env.DATABASE_URL = testUrl.toString();

  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
  const explicitRedis = process.env.TEST_REDIS_URL ? Number(new URL(process.env.TEST_REDIS_URL).pathname.replace(/^\//, '') || 0) : NaN;
  redisUrl.pathname = `/${Number.isFinite(explicitRedis) ? (explicitRedis + (opts.redisOffset ?? 1)) % 16 : (opts.redisDb ?? TEST_REDIS_DB)}`;
  process.env.REDIS_URL = redisUrl.toString();
  const r = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    await r.ping();
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
  process.env.SLACK_FAKE = '1';
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
  const { migrate } = await import('../db/migrate.js');
  await migrate();
  return true;
}

export async function resetTestState() {
  const { sql } = await import('../db/index.js');
  const { redis } = await import('../core/redis.js');
  await sql`truncate threads, messages, slack_events_seen, idempotency_keys, usage cascade`;
  await redis.flushdb();
}
