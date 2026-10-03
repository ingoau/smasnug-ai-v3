/** Per-user memory storage. Every function takes the owning user explicitly and scopes every query to it. */
import { sql } from '../../db/index.js';

export interface Fact {
  id: number;
  userId: string;
  text: string;
  sourceThread: string | null;
  createdAt: Date;
  lastUsed: Date;
}

export const FACT_MAX_CHARS = 500;
/** Hard cap per user so a loop or abuse can't grow memory unbounded. */
export const FACTS_PER_USER_MAX = 200;

/** `m_42`, `[m_42]`, `42` → 42. */
export function parseFactId(raw: string | number): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  const m = /^\s*\[?\s*(?:m_?)?(\d{1,15})\s*\]?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const factLabel = (id: number) => `m_${id}`;

export function cleanFactText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

/** bigserial comes back as a string from postgres.js; facts use numeric ids everywhere. */
const norm = <T extends { id: number | string }>(r: T) => ({ ...r, id: Number(r.id) });

export async function listFacts(userId: string, limit = 500): Promise<Fact[]> {
  const rows = await sql<Fact[]>`select * from user_memory where user_id = ${userId} order by last_used desc, id desc limit ${limit}`;
  return rows.map(norm);
}

export async function countFacts(userId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from user_memory where user_id = ${userId}`;
  return r?.n ?? 0;
}

export async function addFact(userId: string, text: string, sourceThread: string | null): Promise<Fact> {
  const [row] = await sql<Fact[]>`
    insert into user_memory (user_id, text, source_thread) values (${userId}, ${text}, ${sourceThread}) returning *`;
  return norm(row!);
}

export async function updateFact(userId: string, id: number, text: string, sourceThread: string | null): Promise<boolean> {
  const rows = await sql`
    update user_memory set text = ${text}, source_thread = coalesce(${sourceThread}, source_thread), last_used = now()
    where id = ${id} and user_id = ${userId} returning id`;
  return rows.length > 0;
}

export async function deleteFact(userId: string, id: number): Promise<boolean> {
  const rows = await sql`delete from user_memory where id = ${id} and user_id = ${userId} returning id`;
  return rows.length > 0;
}

export async function deleteAllFacts(userId: string): Promise<number> {
  const rows = await sql`delete from user_memory where user_id = ${userId} returning id`;
  return rows.length;
}

export async function touchFacts(userId: string, ids: number[]) {
  if (ids.length === 0) return;
  await sql`update user_memory set last_used = now() where user_id = ${userId} and id = any(${ids}::bigint[])`;
}

/** Facts not used for ~6 months expire. */
export async function expireFacts(olderThanMs: number): Promise<number> {
  const rows = await sql`delete from user_memory where last_used < now() - ${olderThanMs / 1000} * interval '1 second' returning id`;
  return rows.length;
}
