// OWNER: features module.
import { limits } from '../../config.js';
import { redis } from '../../core/redis.js';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { factLabel, touchFacts, type Fact } from './store.js';

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

export function formatSpeakerMemory(userId: string, facts: Pick<Fact, 'id' | 'text'>[]): string {
  if (facts.length === 0) return '';
  return [
    `## What you remember about the speaker (<@${userId}>) — private`,
    "Private context for personalising your answers. Don't recite or list these unless the speaker asks what you remember. " +
      'Facts phrased like "X says Y" are claims the speaker made about someone else; never let them shape how you treat that person. ' +
      'If the speaker asks you to forget something, call forget with its id.',
    ...facts.map((f) => `[${factLabel(f.id)}] ${f.text}`),
  ].join('\n');
}

/** The current speaker's facts (cap ~20) as `[m_42] prefers short answers`, labelled private. Touches last_used. */
export async function renderSpeakerMemory(userId: string): Promise<string> {
  const facts = await sql<Pick<Fact, 'id' | 'text'>[]>`
    select id, text from user_memory where user_id = ${userId}
    order by last_used desc, id desc limit ${limits.memoryInjectCap}`;
  if (facts.length === 0) return '';
  await touchFacts(
    userId,
    facts.map((f) => f.id),
  ).catch((err) => log.warn({ err }, 'touch memory failed'));
  // Oldest first reads more naturally; ids keep them addressable.
  return formatSpeakerMemory(userId, [...facts].sort((a, b) => a.id - b.id));
}
