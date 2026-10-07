/**
 * turn-debounce processor: a (thread, author) window closed. Take the batch, push it into the author's running turn
 * if possible, otherwise gate (if needed) and schedule a turn.
 */
import type { Job } from 'bullmq';
import { appendEvent, parseThreadId } from '../core/events.js';
import { getBotIdentity } from '../core/slack.js';
import { env, limits } from '../config.js';
import { sql } from '../db/index.js';
import { recordModelUsage } from '../features/guard.js';
import { log } from '../log.js';
import { markMessage } from '../core/timing.js';
import { isLatestSeq, takeBatch, type DebounceJob } from './debounce.js';
import { clearIntakeStatus } from './session-status.js';
import { runGate, type GateResult } from './gate.js';
import { batchIsAddressed, batchIsMention, batchIsPartnerLike, batchNeedsGate, gateThreshold, isCooling } from './rules.js';
import { pushToRunningTurn, scheduleMessages } from './scheduler.js';
import { getThread, loadMessages, recentMessages } from './store.js';
import { djGateNote } from '../features/huddlefm/render.js';

/** The gate's note for a partner batch: who the author is to the bot (code-written, from thread state). */
export function partnerGateNote(botName: string): string {
  return `The newest message comes from the person ${botName} was just talking with in this thread (no one else has written since ${botName}'s last reply, or only the two of them are in the thread): a question, request or follow-up from them is most likely meant for ${botName}.`;
}

/** The gate's note for someone else's first message after the bot's question / offer (rules.ts 'answer_other'). */
export function answerGateNote(botName: string): string {
  return `${botName}'s latest message in this thread ended with a question or an offer for another person, and the newest message is the first anyone has written since: it may well be answering ${botName}'s question or taking up its offer.`;
}

/** Swappable for tests. */
export const gateImpl: { run: typeof runGate } = { run: runGate };

export async function processDebounce(job: Job<DebounceJob>) {
  const { threadId, authorId } = job.data;
  const firedAt = Date.now();
  const batch = await takeBatch(job.data);
  if (!batch) {
    // Superseded by a newer message's job (nothing to do), or emptied by deletions / native stop: then no turn
    // follows, so take back the status shown at intake.
    if (await isLatestSeq(job.data)) await clearIntakeStatus(threadId, authorId);
    return;
  }

  const { channelId } = parseThreadId(threadId);
  const msgs = await loadMessages(channelId, batch.map((b) => b.ts));
  if (msgs.length === 0) {
    await clearIntakeStatus(threadId, authorId); // everything was deleted meanwhile
    return;
  }
  const liveTs = new Set(msgs.map((m) => m.ts));
  const items = batch.filter((b) => liveTs.has(b.ts));
  const ts = items.map((b) => b.ts);
  const reasons = items.map((b) => b.reason);
  const isMention = batchIsMention(reasons);

  // Same author mid-turn with a tool boundary coming: inject into the running turn, no gate. Each row keeps its
  // reason: leftovers the turn never drained go through the gate if they needed it (scheduler.finishTurn).
  const pushed = await pushToRunningTurn(threadId, authorId, ts, isMention, items);
  if (pushed != null) {
    await appendEvent(threadId, 'inbox_push', authorId, { turnId: pushed, messageTs: ts });
    return;
  }

  const needsGate = batchNeedsGate(reasons);
  // Partner threshold: the bot's conversation partner ('partner'), or someone else answering it ('answer_other').
  const partner = batchIsPartnerLike(reasons);
  const answersOther = partner && !reasons.includes('partner');
  if (needsGate) {
    const thread = await getThread(threadId);
    if (!thread?.engaged) return; // disengaged while the window was open
    const bot = await getBotIdentity();
    const cooling = isCooling(thread, new Date(), limits.gateCoolingAfterMs);
    const threshold = gateThreshold({ partner, cooling }, { base: env.GATE_THRESHOLD, partner: env.GATE_PARTNER_THRESHOLD, cooling: env.GATE_COOLING_THRESHOLD });
    const [context, djNote] = await Promise.all([recentMessages(threadId, ts[0]!, limits.gateContextMessages), djGateNote({ channelId, threadId })]);
    // Code-written situation for the gate (never thread content).
    const note = [answersOther ? answerGateNote(env.BOT_DISPLAY_NAME) : partner ? partnerGateNote(env.BOT_DISPLAY_NAME) : '', djNote ?? ''].filter(Boolean).join(' ');
    const result: GateResult = await gateImpl.run({ context, newMessages: msgs, botUserId: bot.userId, threshold, ...(note ? { note } : {}) });
    await appendEvent(threadId, 'gate_decision', 'system', {
      messageTs: ts,
      authorId,
      decision: result.respond ? 'yes' : 'no',
      raw: result.raw,
      latencyMs: result.latencyMs,
      model: result.model,
      threshold,
      ...(partner ? { partner: true } : {}),
      ...(answersOther ? { answersOther: true } : {}),
      ...(cooling ? { cooling: true } : {}),
      ...(result.probability !== undefined ? { probability: result.probability } : {}),
      ...(result.fallback ? { fallback: result.fallback } : {}),
      ...(result.error ? { error: result.error.slice(0, 300) } : {}),
    });
    await recordModelUsage({ userId: authorId, threadId, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens }).catch((err) =>
      log.warn({ err }, 'recordModelUsage failed'),
    );
    log.info({ threadId, authorId, respond: result.respond, model: result.model, probability: result.probability, threshold, partner, cooling, fallback: result.fallback, latencyMs: result.latencyMs }, 'gate decision');
    if (!result.respond) return;
    // Addressed: reset the disengagement counters.
    await sql`update threads set last_addressed_at = now(), messages_since_addressed = 0 where id = ${threadId}`;
  }

  // The inbox was just checked above; only re-check after a (slow) gate call. An answer to the bot's question, or a
  // partner follow-up that passed the gate, is framed as talking with the bot (TurnRow.addressed); any other batch
  // that passed the gate as judged to be meant for the bot (TurnRow.gated).
  const res = await scheduleMessages(threadId, authorId, ts, isMention, {
    allowInbox: needsGate,
    addressed: !isMention && batchIsAddressed(reasons),
    gated: !isMention && needsGate,
    items,
  });
  for (const t of ts) markMessage(channelId, t, { debounce_fired: firedAt, turn_created: Date.now() });
  if (res.kind === 'inbox') await appendEvent(threadId, 'inbox_push', authorId, { turnId: res.turnId, messageTs: ts });
}
