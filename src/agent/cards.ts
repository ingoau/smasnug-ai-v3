/**
 * Plan cards: one card message per turn that started runs. The message is a pure render of DB state
 * (card-render.ts); children write progress to the DB and call `scheduleCardRender`, which coalesces updates per
 * card to at most one per `limits.cardCoalesceMs` via a Redis flag + delayed `card-render` job. Updates always go
 * through `chat.update` (never a held-open stream).
 */
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { appendEvent, parseThreadId } from '../core/events.js';
import { enqueue, QUEUE } from '../core/queues.js';
import { redis } from '../core/redis.js';
import { slackCall } from '../core/slack.js';
import { log } from '../log.js';
import { renderCard, type CardRun, type CardState, type RunStatus } from './card-render.js';

export interface CardRow {
  id: number;
  threadId: string;
  turnId: number | null;
  channelId: string;
  messageTs: string | null;
  title: string | null;
  frozen: boolean;
  synthesized: boolean;
}

export async function loadCard(cardId: number): Promise<{ card: CardRow; runs: CardRun[] } | undefined> {
  const [card] = await sql<CardRow[]>`select * from cards where id = ${cardId}`;
  if (!card) return undefined;
  const rows = await sql<
    { id: number; title: string; status: RunStatus; isResume: boolean; details: string | null; steerNotes: string[]; output: string | null; error: string | null }[]
  >`select r.id, s.title, r.status, r.is_resume, r.details, r.steer_notes, r.output, r.error
    from runs r join subagents s on s.id = r.subagent_id where r.card_id = ${cardId} order by r.id`;
  const runs: CardRun[] = rows.map((r) => ({
    id: Number(r.id),
    subagentTitle: r.title,
    status: r.status,
    isResume: r.isResume,
    details: r.details,
    steerNotes: Array.isArray(r.steerNotes) ? r.steerNotes : [],
    output: r.output,
    error: r.error,
  }));
  return { card: { ...card, id: Number(card.id) }, runs };
}

/** Get or create this turn's card row (not yet posted). */
export async function ensureTurnCard(opts: { threadId: string; turnId: number }): Promise<number> {
  const { channelId } = parseThreadId(opts.threadId);
  const [row] = await sql<{ id: number }[]>`
    insert into cards (thread_id, turn_id, channel_id) values (${opts.threadId}, ${opts.turnId}, ${channelId})
    on conflict (turn_id) where turn_id is not null do update set turn_id = excluded.turn_id
    returning id`;
  return Number(row!.id);
}

/** Post the card message in-thread (once). Called after the turn's replies. */
export async function postCard(cardId: number): Promise<void> {
  const loaded = await loadCard(cardId);
  if (!loaded || loaded.card.messageTs || loaded.runs.length === 0) return;
  const { card, runs } = loaded;
  const { threadTs } = parseThreadId(card.threadId);
  const msg = renderCard(toState(card), runs);
  const res = await slackCall<any>(
    'chat.postMessage',
    { channel: card.channelId, thread_ts: threadTs, text: msg.text, blocks: msg.blocks, unfurl_links: false },
    { idempotencyKey: `card:${cardId}` },
  );
  const ts = res.ts ?? res.message?.ts;
  if (!ts) return;
  await sql`update cards set message_ts = ${ts} where id = ${cardId} and message_ts is null`;
  await appendEvent(card.threadId, 'card_posted', 'bot', { cardId, ts, runs: runs.map((r) => r.id) });
  // State may have moved on while posting; make sure the latest state lands.
  await scheduleCardRender(cardId);
}

const pendingKey = (id: number) => `card:pending:${id}`;
const lastKey = (id: number) => `card:last:${id}`;
const lockKey = (id: number) => `card:lock:${id}`;

/** Coalesced re-render: at most one chat.update per card per `limits.cardCoalesceMs`, always the latest state. */
export async function scheduleCardRender(cardId: number | null | undefined): Promise<void> {
  if (!cardId) return;
  try {
    const set = await redis.set(pendingKey(cardId), '1', 'PX', 60_000, 'NX');
    if (!set) return; // a render is already scheduled and will read the latest state
    const last = Number(await redis.get(lastKey(cardId))) || 0;
    const delay = Math.max(0, last + limits.cardCoalesceMs - Date.now());
    await enqueue(QUEUE.cardRender, { cardId }, { delay });
  } catch (err) {
    log.warn({ err, cardId }, 'scheduleCardRender failed');
  }
}

/** Processor for `card-render` jobs. */
export async function processCardRender(cardId: number): Promise<void> {
  await redis.del(pendingKey(cardId));
  await renderCardNow(cardId);
}

/** Render immediately under a per-card lock (so two workers never apply updates out of order). */
export async function renderCardNow(cardId: number): Promise<void> {
  const token = Math.random().toString(36).slice(2);
  const got = await redis.set(lockKey(cardId), token, 'PX', 15_000, 'NX');
  if (!got) {
    // Someone is rendering right now; make sure another render follows theirs.
    await scheduleCardRender(cardId);
    return;
  }
  try {
    await redis.set(lastKey(cardId), String(Date.now()), 'PX', 60_000);
    const loaded = await loadCard(cardId);
    if (!loaded || !loaded.card.messageTs) return; // not posted yet: posting renders the latest state
    const msg = renderCard(toState(loaded.card), loaded.runs);
    await slackCall('chat.update', { channel: loaded.card.channelId, ts: loaded.card.messageTs, text: msg.text, blocks: msg.blocks });
  } catch (err) {
    log.warn({ err, cardId }, 'card render failed');
  } finally {
    // Release only our own lock.
    await redis.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`, 1, lockKey(cardId), token);
  }
}

/** Freeze a card after its synthesis: final title, buttons removed. */
export async function freezeCard(cardId: number): Promise<void> {
  await sql`update cards set frozen = true where id = ${cardId}`;
  await renderCardNow(cardId);
}

function toState(card: CardRow): CardState {
  return { id: card.id, title: card.title, frozen: card.frozen };
}
