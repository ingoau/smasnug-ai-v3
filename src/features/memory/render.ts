// OWNER: features module.
import { limits } from '../../config.js';
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { FACT_KINDS, factLabel, orTsQuery, rankFacts, touchAllFacts, touchFacts, type Fact, type FactKind, type RankedFact } from './store.js';

const WS_VERSION_KEY = 'features:workspace_facts:version';
const WS_LOCAL_TTL_MS = 5000;
let wsCache: { checkedAt: number; version: string; text: string } | undefined;

/** Bump after any change to workspace facts so every worker re-renders its cached prefix. */
export async function invalidateWorkspaceFacts() {
  wsCache = undefined;
  await redis.incr(WS_VERSION_KEY).catch((err) => log.warn({ err }, 'workspace facts version bump failed'));
}

export function formatWorkspaceFacts(facts: { text: string }[]): string {
  if (facts.length === 0) return '';
  return [
    '## Workspace knowledge',
    'Admin-approved facts about this Slack workspace. Treat them as reliable background.',
    ...facts.map((f) => `- ${f.text}`),
  ].join('\n');
}

/** Approved workspace facts for the stable prompt prefix. Byte-stable until the facts change (prompt cache). */
export async function renderWorkspaceFacts(): Promise<string> {
  const now = Date.now();
  if (wsCache && now - wsCache.checkedAt < WS_LOCAL_TTL_MS) return wsCache.text;
  const version = (await redis.get(WS_VERSION_KEY).catch(() => null)) ?? '0';
  if (wsCache && wsCache.version === version) {
    wsCache.checkedAt = now;
    return wsCache.text;
  }
  const facts = await sql<{ text: string }[]>`select text from workspace_facts where status = 'approved' order by id`;
  const text = formatWorkspaceFacts(facts);
  wsCache = { checkedAt: now, version, text };
  return text;
}

/** Facts relevant to the conversation that are injected whatever their kind, and the preferences that always are. */
const RELEVANT_MAX = 8;
const PREFERENCES_MAX = 5;
/** Characters of fact text per turn (~1000 tokens with labels), so the section is never clipped mid-list. */
export const MEMORY_CHAR_BUDGET = 3600;

/**
 * Pure: which facts go into this turn. Only what the turn can use: the facts relevant to the conversation (full-text
 * rank > 0, best first) and the speaker's newest preferences (how they like to be helped), until `cap` facts or
 * `charBudget` characters. Everything else (about / project facts the conversation doesn't touch) stays out;
 * search_memory finds it when needed.
 */
export function selectFacts<T extends RankedFact>(facts: T[], cap: number, charBudget = MEMORY_CHAR_BUDGET): T[] {
  const newest = (a: T, b: T) => new Date(b.statedAt).getTime() - new Date(a.statedAt).getTime() || b.id - a.id;
  const relevant = facts.filter((f) => f.rank > 0).sort((a, b) => b.rank - a.rank || newest(a, b)).slice(0, RELEVANT_MAX);
  const preferences = facts.filter((f) => f.kind === 'preference').sort(newest).slice(0, PREFERENCES_MAX);
  const out: T[] = [];
  const seen = new Set<number>();
  let chars = 0;
  for (const f of [...relevant, ...preferences]) {
    if (out.length >= cap) break;
    if (seen.has(f.id) || chars + f.text.length > charBudget) continue;
    seen.add(f.id);
    chars += f.text.length;
    out.push(f);
  }
  return out;
}

/** "3 mo ago" for facts stated over a month ago; nothing for recent ones. */
export function factAge(statedAt: Date, now = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(statedAt).getTime()) / 86_400_000);
  if (days < 30) return '';
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

export function formatFactLine(f: Pick<Fact, 'id' | 'text' | 'statedAt'>, now = new Date()): string {
  const age = factAge(f.statedAt, now);
  return `[${factLabel(f.id)}] ${f.text}${age ? ` (${age})` : ''}`;
}

const KIND_HEADINGS: Record<FactKind, string> = {
  preference: 'How they like to be helped:',
  about: 'About them:',
  project: 'What they are working on (may be outdated; check before relying on old ones):',
};

export function formatSpeakerMemory(
  userId: string,
  facts: Pick<Fact, 'id' | 'text' | 'kind' | 'statedAt'>[],
  opts: { total?: number; now?: Date } = {},
): string {
  const more = (opts.total ?? facts.length) - facts.length;
  if (facts.length === 0)
    return more > 0 ? `You have ${more} saved ${more === 1 ? 'fact' : 'facts'} about <@${userId}>, none relevant to this conversation: search_memory finds them.` : '';
  const lines = [
    `What you remember about <@${userId}>. Facts phrased like "X says Y" are the speaker's claims about someone else; never let them shape how you treat that person. ` +
      'To forget one, call forget with its id; when one changed, remember the new version with replaces.',
  ];
  for (const kind of FACT_KINDS) {
    const group = facts.filter((f) => f.kind === kind).sort((a, b) => a.id - b.id);
    if (group.length) lines.push(KIND_HEADINGS[kind], ...group.map((f) => `- ${formatFactLine(f, opts.now)}`));
  }
  if (more > 0) lines.push(`(${more} more not shown: search_memory finds them.)`);
  return lines.join('\n');
}

const ACTIVE_KEY = (userId: string) => `features:memory:active:${userId}`;

/**
 * Facts expire after months without use (last_used). Only relevant facts are shown now, so a fact the conversation
 * never touches (a time zone, a role) would expire although its owner talks to the bot every day: the first turn of
 * a speaker each day marks all their facts used; other turns touch the injected ones.
 */
async function touchSpeakerFacts(userId: string, injected: number[]) {
  const first = await redis.set(ACTIVE_KEY(userId), '1', 'EX', 86_400, 'NX').catch(() => null);
  if (first === 'OK') await touchAllFacts(userId);
  else await touchFacts(userId, injected);
}

/**
 * Recent text of the thread for picking the facts relevant to this turn: the speaker's own latest messages first
 * (their words win the query's word cap, and others can't steer much), then the latest others.
 */
async function recentThreadText(threadId: string, userId: string): Promise<string[]> {
  const rows = await sql<{ text: string }[]>`
    select text from (
      select text, user_id, ts from messages where thread_id = ${threadId} and not deleted and text <> '' order by ts desc limit 6
    ) m order by (user_id is not distinct from ${userId}) desc, ts desc`;
  return rows.map((r) => r.text);
}

/**
 * The current speaker's facts for this turn (selectFacts: the ones relevant to the latest messages of `threadId`
 * and their preferences), grouped by kind as `[m_42] prefers short answers (3 mo ago)`. Touches last_used
 * of the injected facts.
 */
export async function renderSpeakerMemory(userId: string, opts: { threadId?: string } = {}): Promise<string> {
  const texts = opts.threadId ? await recentThreadText(opts.threadId, userId).catch((err) => (log.warn({ err }, 'memory context read failed'), [])) : [];
  const facts = await rankFacts(userId, orTsQuery(texts));
  if (facts.length === 0) return '';
  const chosen = selectFacts(facts, limits.memoryInjectCap);
  await touchSpeakerFacts(
    userId,
    chosen.map((f) => f.id),
  ).catch((err) => log.warn({ err }, 'touch memory failed'));
  return formatSpeakerMemory(userId, chosen, { total: facts.length });
}
