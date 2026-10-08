/**
 * "Since this round started": for a synthesis (results) turn, what happened in the thread after the turn that
 * started the card's round — the messages that came in (by author and [ts], the text is already in
 * <thread_history>) and the front agent's own subagent actions (cancels, new spawns, steers, resumes, "Stop all").
 * A results turn reads the request as it stands now, not as it was when the round started: a later message may have
 * narrowed or withdrawn it (prod: the user said stop, the bot cancelled the round, and the results turn started the
 * work again from the original request).
 */
import { sql } from '../db/index.js';
import { oneLine } from './util.js';

export type SinceItem =
  | { kind: 'message'; at: number; ts: string; userId: string | null; self: boolean }
  | { kind: 'cancel' | 'spawn' | 'steer' | 'resume'; at: number; subagentId: string; title: string | null; actor: string | null; turnTs: string[] }
  | { kind: 'stop_all'; at: number; actor: string | null; thisCard: boolean };

/** At most this many items (the newest). */
export const MAX_SINCE_ITEMS = 20;

const tsRefs = (ts: string[]) => [...ts].sort((a, b) => Number(a) - Number(b)).map((t) => `[${t}]`).join(' ');

function subagentRef(i: { subagentId: string; title: string | null }): string {
  const t = i.title ? oneLine(i.title, 80) : '';
  return t ? `${i.subagentId} "${t}"` : i.subagentId;
}

function line(i: SinceItem): string {
  switch (i.kind) {
    case 'message':
      return i.self ? `- you replied [${i.ts}]` : `- ${i.userId ? `<@${i.userId}>` : 'someone'} wrote [${i.ts}]`;
    case 'stop_all':
      return i.actor === 'system'
        ? `- every subagent in the thread was stopped (the thread's first message was deleted)`
        : `- ${i.actor ? `<@${i.actor}>` : 'someone'} pressed Stop on ${i.thisCard ? 'this card' : 'a plan card'}`;
    default: {
      const verb = { cancel: 'cancelled', spawn: 'started', steer: 'messaged', resume: 'resumed' }[i.kind];
      const where = i.turnTs.length ? ` (in your turn for ${tsRefs(i.turnTs)})` : '';
      return `- you ${verb} ${subagentRef(i)}${where}`;
    }
  }
}

/** The block's text (oldest first); '' when nothing happened since the round started. */
export function renderSinceRound(items: SinceItem[], max = MAX_SINCE_ITEMS): string {
  if (!items.length) return '';
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const shown = sorted.slice(-max);
  const omitted = sorted.length - shown.length;
  return [
    'Since this round started (oldest first; the messages are in <thread_history>):',
    ...(omitted > 0 ? [`- … ${omitted} earlier`] : []),
    ...shown.map(line),
  ].join('\n');
}

const SUBAGENT_EVENTS = ['cancel', 'spawn', 'steer', 'resume'] as const;

/**
 * Load what happened after the turn that started `cardId`'s round: messages after that turn's own messages (or, for a
 * turn without messages such as an earlier results turn, after it started) that weren't part of it, and the
 * subagent events since it started. `self`: the bot's own user / bot id (its later replies show as "you replied").
 */
export async function loadSinceRound(cardId: number, self?: { userId?: string; botId?: string }): Promise<SinceItem[]> {
  const [turn] = await sql<{ id: number; threadId: string; messageTs: string[]; startedAt: Date | null; createdAt: Date; finishedAt: Date | null }[]>`
    select t.id::int as id, t.thread_id, t.message_ts, t.started_at, t.created_at, t.finished_at
    from cards c join turns t on t.id = c.turn_id where c.id = ${cardId}`;
  if (!turn) return [];
  const since = turn.startedAt ?? turn.createdAt;
  const own = turn.messageTs ?? [];
  const lastOwn = own.length ? own.reduce((a, b) => (Number(b) > Number(a) ? b : a)) : null;
  const afterTs = lastOwn ?? (since.getTime() / 1000).toFixed(6);
  const [messages, events] = await Promise.all([
    sql<{ ts: string; userId: string | null; botId: string | null }[]>`
      select m.ts, m.user_id, m.bot_id from messages m
      where m.thread_id = ${turn.threadId} and not m.deleted and m.ts::numeric > ${afterTs}::numeric
        and not (m.ts = any(${own}::text[]))
        and not exists (select 1 from thread_inbox i where i.turn_id = ${turn.id} and i.message_ts = m.ts)
      order by m.ts::numeric`,
    sql<{ type: string; actor: string | null; payload: any; createdAt: Date; title: string | null; turnTs: string[] | null }[]>`
      select e.type, e.actor, e.payload, e.created_at, s.title,
        (select t.message_ts from turns t where t.id = (case when e.payload->>'turnId' ~ '^[0-9]+$' then (e.payload->>'turnId')::bigint end)) as turn_ts
      from thread_events e left join subagents s on s.id = e.payload->>'subagentId'
      where e.thread_id = ${turn.threadId} and e.created_at >= ${since}
        and e.type in ('cancel', 'spawn', 'steer', 'resume', 'stop_all')
        and not (e.type in ('spawn', 'resume') and e.payload->>'cardId' = ${String(cardId)})
      order by e.id`,
  ]);
  const items: SinceItem[] = [];
  // The bot's own messages up to the end of that turn are its reply / card, not news.
  const turnEnd = turn.finishedAt ? new Date(turn.finishedAt).getTime() : null;
  for (const m of messages) {
    const isSelf = Boolean((self?.userId && m.userId === self.userId) || (self?.botId && m.botId === self.botId));
    if (isSelf && (turnEnd == null || Number(m.ts) * 1000 <= turnEnd)) continue;
    items.push({ kind: 'message', at: Number(m.ts) * 1000, ts: m.ts, userId: m.userId, self: isSelf });
  }
  for (const e of events) {
    const at = new Date(e.createdAt).getTime();
    if (e.type === 'stop_all') {
      const cards: number[] = Array.isArray(e.payload?.cards) ? e.payload.cards.map(Number) : [];
      items.push({ kind: 'stop_all', at, actor: e.actor, thisCard: Number(e.payload?.cardId) === cardId || cards.includes(cardId) });
    } else if ((SUBAGENT_EVENTS as readonly string[]).includes(e.type) && e.payload?.subagentId) {
      items.push({ kind: e.type as (typeof SUBAGENT_EVENTS)[number], at, subagentId: String(e.payload.subagentId), title: e.title, actor: e.actor, turnTs: e.turnTs ?? [] });
    }
  }
  return items;
}
