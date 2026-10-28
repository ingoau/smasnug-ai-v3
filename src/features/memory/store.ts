/** Per-user memory storage. Every function takes the owning user explicitly and scopes every query to it. */
import { sql } from '../../db/index.js';

/** preference: how they want to be helped (the newest few are always injected). about: who they are. project: what they're doing now. */
export const FACT_KINDS = ['preference', 'about', 'project'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface Fact {
  id: number;
  userId: string;
  text: string;
  kind: FactKind;
  sourceThread: string | null;
  createdAt: Date;
  /** When the fact was last stated (added or updated): its age in the prompt. */
  statedAt: Date;
  lastUsed: Date;
}

export const FACT_MAX_CHARS = 300;
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

export function asKind(k: string | null | undefined): FactKind {
  return (FACT_KINDS as readonly string[]).includes(k ?? '') ? (k as FactKind) : 'about';
}

// ---------- pure text helpers ----------

const STOPWORDS = new Set(
  'the and for are but you all any can had her was one our out has him his how its may new now old see two way who did get got let put say she too use with that this have from they will would there their what about which when your been were them then than into more some just also like very want does its im ive youre thats whats here only over such make know think really much even well need help could should a an i me my is am be to of in on at it or as so by do if'.split(
    ' ',
  ),
);
/** Negations survive as "not", so "can't use Docker" never matches "can use Docker". */
const NEGATIONS = new Set(['not', 'no', 'never', 'cant', 'cannot', 'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'wont', 'neither', 'nor']);

function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/<[@#!][^>]*>/g, ' ')
      .replace(/['’]/g, '')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Words for search (3+ chars, or 2+ outside ASCII such as 東京, or containing a digit; no stopwords or negations).
 * Postgres' stemmer handles plurals.
 */
export function contentWords(text: string): string[] {
  return words(text).filter((w) => (w.length >= 3 || /\d/.test(w) || (w.length >= 2 && /[^\x00-\x7f]/.test(w))) && !STOPWORDS.has(w) && !NEGATIONS.has(w));
}

/** Words for comparing two facts: every non-stopword (also "go", "c", "js"), negations as "not", plurals folded. */
export function similarityWords(text: string): string[] {
  return words(text)
    .map((w) => (NEGATIONS.has(w) ? 'not' : w))
    .filter((w) => w === 'not' || !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w));
}

/**
 * Overlap (Jaccard) of two facts' words and word pairs, 0..1, so word order counts too ("TypeScript over Python" vs
 * "Python over TypeScript"). ≥ DUPLICATE_SIMILARITY counts as the same fact.
 */
export function factSimilarity(a: string, b: string): number {
  const grams = (t: string) => {
    const w = similarityWords(t);
    return new Set([...w, ...w.slice(1).map((x, i) => `${w[i]} ${x}`)]);
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let both = 0;
  for (const g of A) if (B.has(g)) both++;
  return both / (A.size + B.size - both);
}
export const DUPLICATE_SIMILARITY = 0.75;
/** Above this, facts are the same even if a distinctive word differs. */
const NEAR_IDENTICAL = 0.9;

/**
 * True if the words only one of the facts has include a distinctive one: capitalised in the text (a name, a
 * language, a project) or containing a digit. "…Sam is handling venues…" vs "…Alex is handling venues…".
 */
export function differsInDistinctiveWord(a: string, b: string): boolean {
  const A = new Set(similarityWords(a));
  const B = new Set(similarityWords(b));
  const diff = new Set([...A].filter((w) => !B.has(w)).concat([...B].filter((w) => !A.has(w))));
  if (diff.size === 0) return false;
  const distinctive = (text: string) =>
    (text.replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => /^\p{Lu}/u.test(w) || /\d/.test(w)).flatMap(similarityWords);
  return [...distinctive(a), ...distinctive(b)].some((w) => diff.has(w));
}

/**
 * The existing fact that `text` duplicates (the closest one), if any. `strict` (for anything destructive: merging,
 * replacing, removing) also requires no distinctive word to differ, unless the facts are near-identical.
 */
export function findDuplicate<T extends { text: string }>(text: string, facts: T[], opts: { strict?: boolean } = {}): T | undefined {
  let best: T | undefined;
  let bestScore = 0;
  for (const f of facts) {
    const s = factSimilarity(text, f.text);
    if (s > bestScore) [best, bestScore] = [f, s];
  }
  if (!best || bestScore < DUPLICATE_SIMILARITY) return undefined;
  if (opts.strict && bestScore < NEAR_IDENTICAL && differsInDistinctiveWord(text, best.text)) return undefined;
  return best;
}

/** Same text up to case, whitespace and punctuation: nothing to change ("was" vs "is" is a change). */
export function sameFact(a: string, b: string) {
  const norm = (t: string) => t.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return norm(a) === norm(b);
}

/** True if `a` and `b` are the same fact for merging (see findDuplicate's strict). */
export function sameThing(a: string, b: string) {
  return !!findDuplicate(a, [{ text: b }], { strict: true });
}

/**
 * An OR tsquery (`robot | arm`) over the content words of `texts` (in order, so put the most important text first),
 * for to_tsquery('english', …): only letters/digits survive, so it can't carry tsquery syntax. Empty when there is
 * nothing to search for.
 */
export function orTsQuery(texts: string[], maxWords = 40): string {
  return [...new Set(texts.flatMap(contentWords))].slice(0, maxWords).join(' | ');
}

/** What memory never stores (prompts of the remember tool and extraction; isSensitive backs it up in code). */
export const NEVER_STORE =
  'health (physical or mental), family situations, relationships or dating, sexuality, religion, politics, money, school grades, contact details, passwords, precise location';

/** Cheap filter for sensitive categories (backs up the prompts; false positives are fine). */
const SENSITIVE =
  /\b(health|illness|sick|disease|diagnos\w*|disorders?|depress\w*|anxiety|adhd|autis\w*|bipolar|ocd|ptsd|therap\w*|medicat\w*|meds|hospital\w*|surgery|cancer|diabet\w*|pregnan\w*|disabilit\w*|disabled|mental|suicid\w*|self[- ]?harm|anorexi\w*|bulimi\w*|eating disorder|divorc\w*|custody|foster|orphan\w*|abus\w*|grie(f|ving)|passed away|funeral|religio\w*|church|mosque|synagogue|temple|gay|lesbian|bisexual|queer|transgender|sexual\w*|girlfriend|boyfriend|dating|crush|immigra\w*|asylum|refugee|home address|phone number|password|salary|debt|police|arrest\w*|jail|prison)\b/i;

export function isSensitive(text: string) {
  return SENSITIVE.test(text);
}

// ---------- queries ----------

/** bigserial comes back as a string from postgres.js; facts use numeric ids everywhere. */
const norm = <T extends { id: number | string; kind?: string }>(r: T) => ({ ...r, id: Number(r.id), ...(r.kind !== undefined ? { kind: asKind(r.kind) } : {}) });

/** All of a user's facts: preferences first, then about, then projects; newest first within each. */
export async function listFacts(userId: string, limit = 500): Promise<Fact[]> {
  const rows = await sql<Fact[]>`
    select * from user_memory where user_id = ${userId} order by case kind when 'preference' then 0 when 'about' then 1 else 2 end, stated_at desc, id desc limit ${limit}`;
  return rows.map(norm);
}

export async function countFacts(userId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from user_memory where user_id = ${userId}`;
  return r?.n ?? 0;
}

export async function addFact(userId: string, text: string, sourceThread: string | null, kind: FactKind = 'about'): Promise<Fact> {
  const [row] = await sql<Fact[]>`
    insert into user_memory (user_id, text, source_thread, kind) values (${userId}, ${text}, ${sourceThread}, ${kind}) returning *`;
  return norm(row!);
}

export async function updateFact(userId: string, id: number, text: string, sourceThread: string | null, kind?: FactKind | null): Promise<boolean> {
  const rows = await sql`
    update user_memory set text = ${text}, kind = coalesce(${kind ?? null}, kind), source_thread = coalesce(${sourceThread}, source_thread),
      stated_at = now(), last_used = now()
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

/** Mark all of a user's facts used: they are still active, so their facts shouldn't expire just for not being shown. */
export async function touchAllFacts(userId: string) {
  await sql`update user_memory set last_used = now() where user_id = ${userId}`;
}

export type RankedFact = Pick<Fact, 'id' | 'text' | 'kind' | 'statedAt'> & { rank: number };

/** Every fact of the user with its full-text relevance to `tsquery` (an orTsQuery; 0 for all when empty). */
export async function rankFacts(userId: string, tsquery: string): Promise<RankedFact[]> {
  const rows = await sql<RankedFact[]>`
    select id, text, kind, stated_at,
      ${
        tsquery
          ? sql`case when to_tsvector('english', text) @@ to_tsquery('english', ${tsquery})
              then ts_rank(to_tsvector('english', text), to_tsquery('english', ${tsquery})) else 0 end::float8`
          : sql`0::float8`
      } as rank
    from user_memory where user_id = ${userId}
    order by id desc limit ${FACTS_PER_USER_MAX + 50}`;
  return rows.map(norm);
}

/** Facts not used for ~6 months expire. */
export async function expireFacts(olderThanMs: number): Promise<number> {
  const rows = await sql`delete from user_memory where last_used < now() - ${olderThanMs / 1000} * interval '1 second' returning id`;
  return rows.length;
}
