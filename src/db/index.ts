import postgres from 'postgres';
import { env } from '../config.js';

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  onnotice: () => {},
  transform: postgres.camel,
});

export type Sql = typeof sql;
