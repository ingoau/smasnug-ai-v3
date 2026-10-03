import postgres from 'postgres';
import { env } from '../config.js';

export const sql = postgres(env.DATABASE_URL, {
  // Queries are short, but up to 50 turns + 50 subagent runs + intake run concurrently per worker.
  max: Number(process.env.PG_POOL_MAX ?? 20),
  onnotice: () => {},
  transform: postgres.camel,
});

export type Sql = typeof sql;
