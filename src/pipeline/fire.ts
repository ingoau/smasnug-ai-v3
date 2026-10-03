/**
 * turn-debounce processor: a (thread, author) window closed. Take the batch, push it into the author's running turn
 * if possible, otherwise gate (if needed) and schedule a turn.
 */
import type { Job } from 'bullmq';
import { appendEvent, parseThreadId } from '../core/events.js';
import { getBotIdentity } from '../core/slack.js';
import { limits } from '../config.js';
import { sql } from '../db/index.js';
import { recordModelUsage } from '../features/guard.js';
import { MODELS } from '../models.js';
import { log } from '../log.js';
import { takeBatch, type DebounceJob } from './debounce.js';
import { runGate, type GateResult } from './gate.js';
import { batchIsMention, batchNeedsGate } from './rules.js';
import { pushToRunningTurn, scheduleMessages } from './scheduler.js';
import { getThread, loadMessages, recentMessages } from './store.js';

/** Swappable for tests. */
export const gateImpl: { run: typeof runGate } = { run: runGate };

export async function processDebounce(job: Job<DebounceJob>) {
  const { threadId, authorId } = job.data;
  const batch = await takeBatch(job.data);
  if (!batch) return; // superseded by a newer message's job, or emptied by deletions

  const { channelId } = parseThreadId(threadId);
  const msgs = await loadMessages(channelId, batch.map((b) => b.ts));
  if (msgs.length === 0) return; // everything was deleted meanwhile
  const liveTs = new Set(msgs.map((m) => m.ts));
  const items = batch.filter((b) => liveTs.has(b.ts));
  const ts = items.map((b) => b.ts);
  const reasons = items.map((b) => b.reason);
  const isMention = batchIsMention(reasons);

  // Same author mid-turn with a tool boundary coming: inject into the running turn, no gate.
  const pushed = await pushToRunningTurn(threadId, authorId, ts, isMention);
  if (pushed != null) {
    await appendEvent(threadId, 'inbox_push', authorId, { turnId: pushed, messageTs: ts });
    return;
  }

  if (batchNeedsGate(reasons)) {
    const thread = await getThread(threadId);
    if (!thread?.engaged) return; // disengaged while the window was open
    const bot = await getBotIdentity();
    const context = await recentMessages(threadId, ts[0]!, limits.gateContextMessages);
    const result: GateResult = await gateImpl.run({ context, newMessages: msgs, botUserId: bot.userId });
    await appendEvent(threadId, 'gate_decision', 'system', {
      messageTs: ts,
      authorId,
      decision: result.respond ? 'yes' : 'no',
      raw: result.raw,
      latencyMs: result.latencyMs,
      model: MODELS.gate,
      ...(result.error ? { error: result.error.slice(0, 300) } : {}),
    });
    await recordModelUsage({ userId: authorId, threadId, model: MODELS.gate, inputTokens: result.inputTokens, outputTokens: result.outputTokens }).catch((err) =>
      log.warn({ err }, 'recordModelUsage failed'),
    );
    log.info({ threadId, authorId, respond: result.respond, latencyMs: result.latencyMs }, 'gate decision');
    if (!result.respond) return;
    // Addressed: reset the disengagement counters.
    await sql`update threads set last_addressed_at = now(), messages_since_addressed = 0 where id = ${threadId}`;
  }

  const res = await scheduleMessages(threadId, authorId, ts, isMention);
  if (res.kind === 'inbox') await appendEvent(threadId, 'inbox_push', authorId, { turnId: res.turnId, messageTs: ts });
}
