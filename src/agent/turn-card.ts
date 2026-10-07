/**
 * A front turn's plan card (one per bot message): its own steps (card-steps.ts: searches, reads, fetches…) and the
 * runs it started, in the reply message the turn delivers. Live, the steps show as the activity stream's plan
 * (activity-trail.ts); when a reply goes out, its layout carries the card rendered from the DB (cards.ts,
 * card-render.ts), and the end of the turn re-renders it with the final state. A turn with no step and no run has no
 * card. Steps are only recorded where activity cards show (mentions, DMs, write-ups): unmentioned follow-ups stay
 * card-free. Best-effort: nothing here throws.
 */
import { log } from '../log.js';
import { attachCard, cardBlockFor, ensureTurnCard, postCard, saveCardSteps, turnCardId, type ReplyRef } from './cards.js';
import { isCardStep, type CardStep } from './card-steps.js';
import type { CardBlock } from './reply.js';

export class TurnCard {
  private readonly steps: (CardStep & { callId: string })[] = [];
  private cardId: number | null = null;
  /** The card went out with a reply of this turn (re-rendered at the end whatever happened since). */
  private attachedTo: string | null = null;

  constructor(private readonly o: { threadId: string; turnId: number; enabled: boolean }) {}

  /** A tool call started: a step on the card if it is work (card-steps.ts). */
  started(callId: string, tool: string): void {
    if (!this.o.enabled || !isCardStep(tool) || this.steps.some((s) => s.callId === callId)) return;
    this.steps.push({ callId, tool, status: 'in_progress' });
  }

  /** A tool call returned (`ok` false only if it threw). */
  done(callId: string, ok = true): void {
    const s = this.steps.find((k) => k.callId === callId);
    if (s && s.status === 'in_progress') s.status = ok ? 'complete' : 'error';
  }

  /** The steps so far (a step still running at the end of the turn counts as done: it never failed). */
  list(final = false): CardStep[] {
    return this.steps.map(({ tool, status }) => ({ tool, status: final && status === 'in_progress' ? 'complete' : status }));
  }

  /** The card's id, created once there is a step (a spawn creates it on its own). */
  private async id(): Promise<number | null> {
    if (this.cardId) return this.cardId;
    this.cardId = (await turnCardId(this.o.turnId)) ?? (this.steps.length ? await ensureTurnCard({ threadId: this.o.threadId, turnId: this.o.turnId }) : null);
    return this.cardId;
  }

  /** The card for a reply about to go out (ReplyTarget.card): null without steps and runs or when it lives elsewhere. */
  async block(): Promise<CardBlock | null> {
    if (!this.o.enabled) return null;
    const id = await this.id();
    if (!id) return null;
    if (this.steps.length) await saveCardSteps(id, this.list());
    return cardBlockFor(id);
  }

  /** The card went out with the reply in message `ts`. */
  async attached(ts: string, text: string): Promise<void> {
    if (!this.cardId) return;
    await attachCard(this.cardId, ts, text);
    this.attachedTo = ts;
  }

  /**
   * End of the turn: record the final steps and show the card where it belongs: re-rendered in the reply it went out
   * with, else attached to the turn's last reply (runs without a reply get a message of their own). `runs`: the turn
   * started runs it still delegates to.
   */
  async finish(lastReply: ReplyRef | null, runs: boolean): Promise<void> {
    try {
      const id = this.o.enabled || runs ? await this.id() : null;
      if (!id) return;
      if (this.steps.length) await saveCardSteps(id, this.list(true));
      if (runs || this.steps.length || this.attachedTo) await postCard(id, lastReply);
    } catch (err) {
      log.error({ err, turnId: this.o.turnId }, 'showing the turn card failed');
    }
  }
}
