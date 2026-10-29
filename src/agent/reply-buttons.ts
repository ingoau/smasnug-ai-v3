/**
 * Quick-reply buttons under a bot reply (reply tool `buttons`): pure label cleaning and block rendering, no I/O.
 * Persistence lives in reply-buttons-store.ts; the press handler in src/pipeline/reply-choice.ts.
 *
 * A reply with buttons gets an `actions` block (block_id `reply_<id>_buttons`, one button per label, action_id
 * `reply:choice:<i>`, value = the reply_buttons row id). Once pressed, the block is replaced by a context block
 * (`reply_<id>_pressed`): "<@U> pressed *label*".
 *
 * A button can be marked as one that doesn't start a model turn (`{ label, no_turn: true }`, optionally with a
 * `fixed_reply` posted by code): its action_id is `reply:quiet:<i>` (handler: reply-quiet.ts), its response is stored
 * in reply_buttons.responses (null for older rows: every button starts a turn).
 */
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';

export const REPLY_CHOICE_ACTION = 'reply:choice';
/** A button that doesn't start a turn (reply-quiet.ts). Not a prefix of REPLY_CHOICE_ACTION or the other way round. */
export const REPLY_QUIET_ACTION = 'reply:quiet';
/** A fixed reply is cut at this length (it's meant to be a short "all good"). */
export const MAX_FIXED_REPLY_CHARS = 500;

/** What pressing a no-turn button does: nothing more than the "pressed" note, or that plus a code-posted text. */
export type ButtonResponse = { kind: 'none' } | { kind: 'text'; text: string };
export const MAX_BUTTONS = 5;
/** Label length the tool asks for (guidance for the model; not enforced). */
export const MAX_LABEL_CHARS = 30;
/** Slack: a button's plain_text `text` is at most 75 characters. */
export const SLACK_BUTTON_TEXT_MAX = 75;

/** What a render needs to know about a reply's buttons. */
export interface ButtonsState {
  id: number;
  labels: string[];
  pressedBy?: string | null;
  pressedLabel?: string | null;
  /** Per button (same order as labels): null / missing = a press starts a turn as usual. */
  responses?: (ButtonResponse | null)[] | null;
}

export interface ButtonElement {
  type: 'button';
  action_id: string;
  value: string;
  text: { type: 'plain_text'; text: string; emoji?: boolean };
  style?: 'danger' | 'primary';
}
export interface ButtonsActionsBlock {
  type: 'actions';
  block_id?: string;
  elements: ButtonElement[];
}
export interface ContextBlock {
  type: 'context';
  block_id?: string;
  elements: { type: 'mrkdwn'; text: string }[];
}

/**
 * Model-written labels → what gets shown: exactly as written, except group pings are neutralised (workspace
 * guideline) and Slack's hard API limits: button text is 1-75 chars (empty labels dropped, longer ones cut at 75),
 * and the tool documents at most MAX_BUTTONS buttons.
 */
export function normalizeButtonLabels(labels: readonly unknown[] | null | undefined): string[] {
  return normalizeButtons(labels).labels;
}

/**
 * The reply tool's `buttons` (each a label, or `{ label, no_turn?, fixed_reply? }`) → labels as shown (see
 * normalizeButtonLabels) and, per label, what a press does: a non-empty fixed_reply → post it (no turn); no_turn →
 * just the "pressed" note; else null (a turn, as before). Fixed replies are model text: group pings neutralised.
 */
export function normalizeButtons(raw: readonly unknown[] | null | undefined): { labels: string[]; responses: (ButtonResponse | null)[] } {
  const labels: string[] = [];
  const responses: (ButtonResponse | null)[] = [];
  for (const item of raw ?? []) {
    const obj = item && typeof item === 'object' ? (item as { label?: unknown; no_turn?: unknown; fixed_reply?: unknown }) : null;
    const label = typeof item === 'string' ? item : obj?.label;
    if (typeof label !== 'string' || !label.trim()) continue;
    const l = neutralizeBroadcasts(label);
    labels.push([...l].length > SLACK_BUTTON_TEXT_MAX ? [...l].slice(0, SLACK_BUTTON_TEXT_MAX).join('') : l);
    const fixed = typeof obj?.fixed_reply === 'string' ? obj.fixed_reply.trim() : '';
    responses.push(fixed ? { kind: 'text', text: neutralizeBroadcasts([...fixed].slice(0, MAX_FIXED_REPLY_CHARS).join('')) } : obj?.no_turn === true ? { kind: 'none' } : null);
    if (labels.length >= MAX_BUTTONS) break;
  }
  return { labels, responses };
}

/** A stored response (reply_buttons.responses entry) → ButtonResponse; anything unrecognised = null (a turn). */
export function parseButtonResponse(v: unknown): ButtonResponse | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { kind?: unknown; text?: unknown };
  if (r.kind === 'none') return { kind: 'none' };
  if (r.kind === 'text' && typeof r.text === 'string' && r.text.trim()) return { kind: 'text', text: r.text };
  return null;
}

export const buttonsBlockId = (id: number) => `reply_${id}_buttons`;
export const pressedBlockId = (id: number) => `reply_${id}_pressed`;

export function buttonsActions(b: Pick<ButtonsState, 'id' | 'labels' | 'responses'>): ButtonsActionsBlock {
  return {
    type: 'actions',
    block_id: buttonsBlockId(b.id),
    elements: b.labels.map((label, i) => ({
      type: 'button' as const,
      action_id: `${b.responses?.[i] ? REPLY_QUIET_ACTION : REPLY_CHOICE_ACTION}:${i}`,
      value: String(b.id),
      text: { type: 'plain_text' as const, text: label, emoji: true },
    })),
  };
}

/** mrkdwn-safe label for inside `*…*`. */
function mrkdwnLabel(label: string): string {
  return label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*`]/g, '');
}

export function pressedText(b: Pick<ButtonsState, 'pressedBy' | 'pressedLabel'>): string {
  return `<@${b.pressedBy}> pressed *${mrkdwnLabel(b.pressedLabel ?? '')}*`;
}

export function pressedNote(b: ButtonsState): ContextBlock {
  return { type: 'context', block_id: pressedBlockId(b.id), elements: [{ type: 'mrkdwn', text: pressedText(b) }] };
}

/** The buttons (not pressed yet) or the "pressed" note (pressed). */
export function buttonsBlock(b: ButtonsState): ButtonsActionsBlock | ContextBlock {
  return b.pressedBy && b.pressedLabel != null ? pressedNote(b) : buttonsActions(b);
}

/** Plain-text fallback for a message that carries only buttons (no reply text). */
export function buttonsFallbackText(b: ButtonsState): string {
  return b.pressedBy && b.pressedLabel != null ? pressedText(b) : `Options: ${b.labels.join(' | ')}`;
}
