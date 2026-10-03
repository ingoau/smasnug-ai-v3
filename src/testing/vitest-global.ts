/**
 * vitest `globalSetup`: creates and migrates the test database once per run when Postgres is reachable. Without
 * local infra this is a no-op (unit tests mock the DB; integration tests skip or fail on their own).
 */
import postgres from 'postgres';
import { applyTestEnv } from './test-db.js';

export default async function setup(): Promise<void> {
  applyTestEnv();
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {}, connect_timeout: 2 });
  try {
    const exists = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (exists.length === 0) await admin.unsafe(`create database "${dbName.replace(/"/g, '""')}"`);
  } catch {
    return; // no local Postgres
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.LOG_LEVEL ||= 'warn';
  const { migrate } = await import('../db/migrate.js');
  const { sql } = await import('../db/index.js');
  try {
    await migrate();
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}
