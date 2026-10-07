import postgres from 'postgres';
import { env } from '../config.js';
import { wellFormedJson } from './json.js';

// Typed as without custom types (the json override changes no query's types; TransactionSql<{}> stays compatible).
export const sql = postgres(env.DATABASE_URL, {
  // Queries are short, but up to 50 turns + 50 subagent runs + intake run concurrently per worker.
  max: Number(process.env.PG_POOL_MAX ?? 20),
  onnotice: () => {},
  transform: postgres.camel,
  // json / jsonb parameters (sql.json, and every object postgres.js serializes as json): like the default, except that
  // a lone UTF-16 surrogate (text cut in the middle of an emoji) becomes U+FFFD. Postgres rejects it ("Unicode low
  // surrogate must follow a high surrogate", 22P02), which failed whole writes (e.g. a subagent run's history).
  types: { wellFormedJson: { to: 3802, from: [114, 3802], serialize: wellFormedJson, parse: (x: string) => JSON.parse(x) } },
}) as unknown as postgres.Sql<{}>;

export type Sql = typeof sql;
