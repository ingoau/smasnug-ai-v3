/**
 * Latency instrumentation. A message's path crosses processes and jobs (ingress → slack-events → debounce →
 * thread-run → front turn), so per-message marks live in a short-lived Redis hash; the turn collects them together
 * with its own in-memory marks and writes one `turn_timing` thread event + log line at the end.
 *
 * All marks are absolute epoch ms. Writes are fire-and-forget: timing must never slow down or break the hot path.
 */
import { redis } from './redis.js';
import { log } from '../log.js';

const TTL_MS = 10 * 60 * 1000;
export const msgTimingKey = (channelId: string, ts: string) => `timing:msg:${channelId}:${ts}`;

/** Record pipeline marks for a message (first value per field wins). Never throws, never awaited on the hot path. */
export function markMessage(channelId: string, ts: string, fields: Record<string, number | undefined>): void {
  const key = msgTimingKey(channelId, ts);
  const m = redis.multi();
  let n = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || !Number.isFinite(v)) continue;
    m.hsetnx(key, k, String(Math.round(v)));
    n++;
  }
  if (!n) return;
  m.pexpire(key, TTL_MS);
  m.exec().catch((err) => log.debug({ err }, 'markMessage failed'));
}

export async function loadMessageMarks(channelId: string, ts: string): Promise<Record<string, number>> {
  try {
    const h = await redis.hgetall(msgTimingKey(channelId, ts));
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Number(v)]));
  } catch {
    return {};
  }
}

/** Slack ts ("1700000000.123456") → epoch ms. */
export const slackTsMs = (ts: string) => Math.round(Number(ts) * 1000);

/**
 * One turn's marks and counters. `mark` keeps the first value per name (so "first chunk" etc. are naturally the
 * first occurrence); `span` records a duration; `add` accumulates counters.
 */
export class TurnTiming {
  readonly marks: Record<string, number> = {};
  readonly spans: Record<string, number> = {};
  readonly counters: Record<string, number> = {};
  /** Non-numeric details, e.g. the tool names of each model step. */
  readonly notes: Record<string, unknown> = {};

  mark(name: string, at = Date.now()): void {
    if (!(name in this.marks)) this.marks[name] = at;
  }

  /** Time an async step; records its duration under `name` (ms). */
  async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      this.spans[name] = (this.spans[name] ?? 0) + (Date.now() - t);
    }
  }

  add(name: string, n: number | undefined): void {
    if (n == null || !Number.isFinite(n)) return;
    this.counters[name] = (this.counters[name] ?? 0) + n;
  }

  set(name: string, n: number | undefined): void {
    if (n == null || !Number.isFinite(n)) return;
    this.counters[name] = n;
  }
}

/** Canonical phase order for reports (anything else is appended). */
export const PHASES = [
  'slack_sent',
  'ingress_received',
  'enqueued',
  'intake_start',
  'status_intake',
  'debounce_scheduled',
  'debounce_fired',
  'turn_created',
  'run_picked',
  'lock_acquired',
  'turn_claimed',
  'status_done',
  'context_built',
  'model_request',
  'first_chunk',
  'first_tool_input',
  'first_reply_delta',
  'stream_started',
  'reply_posted',
  'stream_stopped',
  'loop_done',
  'turn_end',
] as const;

/**
 * Flatten message + turn marks into ms offsets from `base` (the user's send time, i.e. the message ts, when known;
 * else ingress receipt). Also derives the headline numbers.
 */
export function timingReport(msgMarks: Record<string, number>, t: TurnTiming) {
  const all: Record<string, number> = { ...msgMarks, ...t.marks };
  const base = all.slack_sent ?? all.ingress_received ?? all.turn_claimed ?? Object.values(all).sort((a, b) => a - b)[0] ?? Date.now();
  const rel: Record<string, number> = {};
  const names = [...PHASES.filter((p) => p in all), ...Object.keys(all).filter((k) => !(PHASES as readonly string[]).includes(k))];
  for (const k of names) rel[k] = all[k]! - base;
  const firstStatus = [all.status_intake, all.status_done].filter((v): v is number => v != null).sort((a, b) => a - b)[0];
  const firstText = [all.stream_started, all.reply_posted].filter((v): v is number => v != null).sort((a, b) => a - b)[0];
  return {
    base,
    rel,
    spans: t.spans,
    counters: t.counters,
    notes: t.notes,
    headline: {
      firstStatusMs: firstStatus != null ? firstStatus - base : null,
      firstTextMs: firstText != null ? firstText - base : null,
      turnEndMs: all.turn_end != null ? all.turn_end - base : null,
    },
  };
}
