/**
 * Quick-reply buttons under a bot reply (reply tool `buttons`): pure label cleaning and block rendering, no I/O.
 * Persistence lives in reply-buttons-store.ts; the press handler in src/pipeline/reply-choice.ts.
 *
 * A reply with buttons gets an `actions` block (block_id `reply_<id>_buttons`, one button per label, action_id
 * `reply:choice:<i>`, value = the reply_buttons row id). Once pressed, the block is replaced by a context block
 * (`reply_<id>_pressed`): "<@U> pressed *label*".
 */
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';

export const REPLY_CHOICE_ACTION = 'reply:choice';
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
  const out: string[] = [];
  for (const raw of labels ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const l = neutralizeBroadcasts(raw);
    out.push([...l].length > SLACK_BUTTON_TEXT_MAX ? [...l].slice(0, SLACK_BUTTON_TEXT_MAX).join('') : l);
    if (out.length >= MAX_BUTTONS) break;
  }
  return out;
}

export const buttonsBlockId = (id: number) => `reply_${id}_buttons`;
export const pressedBlockId = (id: number) => `reply_${id}_pressed`;

export function buttonsActions(b: Pick<ButtonsState, 'id' | 'labels'>): ButtonsActionsBlock {
  return {
    type: 'actions',
    block_id: buttonsBlockId(b.id),
    elements: b.labels.map((label, i) => ({
      type: 'button' as const,
      action_id: `${REPLY_CHOICE_ACTION}:${i}`,
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
