/**
 * Quick-reply buttons under a bot reply (reply tool `buttons`): pure label cleaning and block rendering, no I/O.
 * Persistence lives in reply-buttons-store.ts; the press handler in src/pipeline/reply-choice.ts.
 *
 * A reply with buttons gets an `actions` block (block_id `reply_<id>_buttons`, one button per label, action_id
 * `reply:choice:<i>`, value = the reply_buttons row id). Once pressed, the block is replaced by a context block
 * (`reply_<id>_pressed`): "<@U> pressed *label*".
 *
 * Button types (`{ label, type }`; a bare string is a `prompt` button):
 * - `prompt` (default): a press posts the label as the presser's message and starts a turn (reply-choice.ts).
 * - `text`: code posts a fixed text, no turn.
 * - `none`: only the "pressed" note, no turn.
 * - `action`: code runs a bound tool call (button-actions.ts) with arguments fixed when the reply went out, no turn
 *   unless it fails (then an outcome turn tells the agent).
 * `place` = where the response goes (text: the fixed text; action: `done_text`; prompt: the turn's first reply): `new`
 * (a message of its own), `append` (added below the reply's text in the same message) or `replace` (instead of the
 * reply's text). `who` = who may press: `anyone` or only the `requester` (the person the reply answered). Defaults:
 * actions append and are requester-only; the rest post new and are open to anyone.
 * Every non-prompt button's action_id is `reply:quiet:<i>` (handler: reply-quiet.ts). Responses are stored per button in
 * reply_buttons.responses (null = a plain prompt button; a null column = older rows, every button a prompt).
 * The old `no_turn` / `fixed_reply` object fields still parse (as `none` / `text`).
 * Buttons still unpressed when the bot answers a newer message in the thread are retired (`expired`): the actions block
 * is dropped (a buttons-only message keeps the labels as a grey note) and presses are refused.
 */
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';

export const REPLY_CHOICE_ACTION = 'reply:choice';
/** A button that doesn't start a turn (reply-quiet.ts). Not a prefix of REPLY_CHOICE_ACTION or the other way round. */
export const REPLY_QUIET_ACTION = 'reply:quiet';
/** A fixed reply is cut at this length (it's meant to be a short "all good"). */
export const MAX_FIXED_REPLY_CHARS = 500;

/** Who may press a button. */
export type ButtonWho = 'anyone' | 'requester';
/**
 * What pressing a button does (stored in reply_buttons.responses; single-word keys, the DB's camelCase transform
 * would rewrite others). `args` is the action's arguments as a JSON string. Null = a plain prompt button.
 */
export type ButtonResponse =
  | { kind: 'prompt'; place?: ButtonPlace; who?: ButtonWho }
  | { kind: 'none'; who?: ButtonWho }
  | { kind: 'text'; text: string; place?: ButtonPlace; who?: ButtonWho }
  | { kind: 'action'; tool: string; args: string; done?: string; place?: ButtonPlace; who?: ButtonWho };
/** Where a button's response goes: a new message, appended to the reply's message, or replacing its text. */
export type ButtonPlace = 'new' | 'append' | 'replace';
const PLACES = new Set<string>(['new', 'append', 'replace']);
/** What an action button's press did (reply_buttons.outcome). */
export interface ButtonOutcome {
  ok: boolean;
  text: string;
  /**
   * Shown instead of the "pressed · done ✓" note once it worked: what the press made, when the action knows it only
   * after running (e.g. "Moved → <link>" for move_to_code_channel). Slack mrkdwn written by code, not the model.
   */
  note?: string;
}
/** Action arguments are cut off (and the action dropped) beyond this many JSON characters. */
export const MAX_ACTION_ARGS_CHARS = 4000;

/** Who may press button `index` of a row (stored response; actions default to the requester). */
export function buttonWho(r: ButtonResponse | null | undefined): ButtonWho {
  return r?.who ?? (r?.kind === 'action' ? 'requester' : 'anyone');
}

/** Where a button's response goes (actions default to append, the rest to a new message). */
export function buttonPlace(r: ButtonResponse | null | undefined): ButtonPlace {
  if (!r || r.kind === 'none') return 'new';
  return r.place ?? (r.kind === 'action' ? 'append' : 'new');
}

/** The reply's text with a response placed into it (`append`: below it; `replace`: instead of it). */
export function placeText(replyText: string | null, response: string, place: 'append' | 'replace'): string {
  return place === 'append' && replyText?.trim() ? `${replyText.trimEnd()}\n\n${response}` : response;
}

/** The stored response of the pressed button (by its index; older rows: by its label), or null. */
export function pressedResponse(b: Pick<ButtonsState, 'labels' | 'pressedLabel' | 'responses'> & Pick<Partial<ButtonsState>, 'pressedIndex'>): ButtonResponse | null {
  if (b.pressedLabel == null) return null;
  const i = b.pressedIndex ?? b.labels.indexOf(b.pressedLabel);
  return i >= 0 ? (b.responses?.[i] ?? null) : null;
}
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
  /** An action button's result, once it ran. */
  outcome?: ButtonOutcome | null;
  /** Which button was pressed (null on older rows: found by its label). */
  pressedIndex?: number | null;
  /** Retired unpressed (the bot answered a newer message): no buttons shown. */
  expired?: boolean;
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

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const cut = (v: string, n: number) => ([...v].length > n ? [...v].slice(0, n).join('') : v);

/**
 * The reply tool's `buttons` (each a label, or `{ label, type?, text?, action?, done_text?, place?, who? }`) → labels as
 * shown (see normalizeButtonLabels) and, per label, what a press does (null = a plain prompt button). Lenient: an
 * unknown type is inferred from the fields given, a `text` button without text is a `none` one, an `action` button
 * without a usable action is a prompt one (`notes` says so). Texts are model text: group pings neutralised.
 * Action buttons are checked further before the reply goes out (button-actions.ts prepareButtonActions).
 */
export function normalizeButtons(raw: readonly unknown[] | null | undefined): { labels: string[]; responses: (ButtonResponse | null)[]; notes: string[] } {
  const labels: string[] = [];
  const responses: (ButtonResponse | null)[] = [];
  const notes: string[] = [];
  for (const item of raw ?? []) {
    const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const label = typeof item === 'string' ? item : obj?.label;
    if (typeof label !== 'string' || !label.trim()) continue;
    const shown = cut(neutralizeBroadcasts(label), SLACK_BUTTON_TEXT_MAX);
    labels.push(shown);
    responses.push(obj ? buttonResponse(obj, shown, notes) : null);
    if (labels.length >= MAX_BUTTONS) break;
  }
  return { labels, responses, notes };
}

const KINDS = new Set(['prompt', 'text', 'none', 'action']);

function buttonResponse(obj: Record<string, unknown>, label: string, notes: string[]): ButtonResponse | null {
  const type = str(obj.type).toLowerCase();
  const text = str(obj.text) || str(obj.fixed_reply);
  const rawAction = obj.action && typeof obj.action === 'object' ? (obj.action as Record<string, unknown>) : null;
  const kind = KINDS.has(type) ? type : rawAction ? 'action' : text ? 'text' : obj.no_turn === true ? 'none' : 'prompt';
  const whoRaw = str(obj.who).toLowerCase();
  const who: ButtonWho | undefined = whoRaw === 'requester' || whoRaw === 'anyone' ? whoRaw : undefined;
  const placeRaw = str(obj.place).toLowerCase();
  const place = PLACES.has(placeRaw) ? (placeRaw as ButtonPlace) : undefined;
  const opt = { ...(place ? { place } : {}), ...(who ? { who } : {}) };
  if (kind === 'none' || (kind === 'text' && !text)) return { kind: 'none', ...(who ? { who } : {}) };
  if (kind === 'text') return { kind: 'text', text: neutralizeBroadcasts(cut(text, MAX_FIXED_REPLY_CHARS)), ...opt };
  if (kind === 'action') {
    const tool = str(rawAction?.tool);
    // Models sometimes send nested arguments as a JSON string.
    let rawArgs: unknown = rawAction?.args;
    if (typeof rawArgs === 'string') {
      try {
        rawArgs = JSON.parse(rawArgs);
      } catch {
        rawArgs = null;
      }
    }
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const json = JSON.stringify(args);
    if (!tool) notes.push(`Button "${label}" has no action.tool, so it starts a turn like a normal button.`);
    else if (json.length > MAX_ACTION_ARGS_CHARS) notes.push(`Button "${label}": the action's args are too long, so it starts a turn like a normal button.`);
    else {
      const done = str(obj.done_text);
      return { kind: 'action', tool, args: json, ...(done ? { done: neutralizeBroadcasts(cut(done, MAX_FIXED_REPLY_CHARS)) } : {}), ...opt };
    }
    // Falls back to a prompt button that keeps the action's default: only the requester may press it.
    return who === 'anyone' ? null : { kind: 'prompt', who: 'requester' };
  }
  // prompt: stored only when it differs from a plain button.
  const placed = place && place !== 'new' ? place : undefined;
  return placed || who === 'requester' ? { kind: 'prompt', ...(placed ? { place: placed } : {}), ...(who === 'requester' ? { who } : {}) } : null;
}

/** A stored response (reply_buttons.responses entry) → ButtonResponse; anything unrecognised = null (a prompt). */
export function parseButtonResponse(v: unknown): ButtonResponse | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const who: ButtonWho | undefined = r.who === 'requester' || r.who === 'anyone' ? r.who : undefined;
  const place = typeof r.place === 'string' && PLACES.has(r.place) ? (r.place as ButtonPlace) : undefined;
  const opt = { ...(place ? { place } : {}), ...(who ? { who } : {}) };
  if (r.kind === 'none') return { kind: 'none', ...(who ? { who } : {}) };
  if (r.kind === 'text' && typeof r.text === 'string' && r.text.trim()) return { kind: 'text', text: r.text, ...opt };
  if (r.kind === 'prompt') return { kind: 'prompt', ...opt };
  if (r.kind === 'action' && typeof r.tool === 'string' && r.tool && typeof r.args === 'string') {
    return { kind: 'action', tool: r.tool, args: r.args, ...(typeof r.done === 'string' && r.done ? { done: r.done } : {}), ...opt };
  }
  return null;
}

/** A stored outcome → ButtonOutcome (null if absent / malformed). */
export function parseButtonOutcome(v: unknown): ButtonOutcome | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { ok?: unknown; text?: unknown; note?: unknown };
  if (typeof o.ok !== 'boolean') return null;
  return { ok: o.ok, text: typeof o.text === 'string' ? o.text : '', ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}) };
}

export const buttonsBlockId = (id: number) => `reply_${id}_buttons`;
export const pressedBlockId = (id: number) => `reply_${id}_pressed`;

export function buttonsActions(b: Pick<ButtonsState, 'id' | 'labels' | 'responses'>): ButtonsActionsBlock {
  return {
    type: 'actions',
    block_id: buttonsBlockId(b.id),
    elements: b.labels.map((label, i) => ({
      type: 'button' as const,
      action_id: `${b.responses?.[i] && b.responses[i]!.kind !== 'prompt' ? REPLY_QUIET_ACTION : REPLY_CHOICE_ACTION}:${i}`,
      value: String(b.id),
      text: { type: 'plain_text' as const, text: label, emoji: true },
    })),
  };
}

/** mrkdwn-safe label for inside `*…*`. */
function mrkdwnLabel(label: string): string {
  return label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*`]/g, '');
}

/** "<@U> pressed *label*", plus how an action button's run went (running / done / failed). */
export function pressedText(b: Pick<ButtonsState, 'pressedBy' | 'pressedLabel'> & Partial<Pick<ButtonsState, 'labels' | 'responses' | 'outcome' | 'pressedIndex'>>): string {
  const base = `<@${b.pressedBy}> pressed *${mrkdwnLabel(b.pressedLabel ?? '')}*`;
  const r = b.labels ? pressedResponse({ labels: b.labels, pressedLabel: b.pressedLabel ?? null, responses: b.responses ?? null, pressedIndex: b.pressedIndex ?? null }) : null;
  if (r?.kind !== 'action') return base;
  if (!b.outcome) return `${base} · working on it…`;
  if (b.outcome.ok && b.outcome.note) return b.outcome.note;
  return b.outcome.ok ? `${base} · done ✓` : `${base} · didn't work`;
}

export function pressedNote(b: ButtonsState): ContextBlock {
  return { type: 'context', block_id: pressedBlockId(b.id), elements: [{ type: 'mrkdwn', text: pressedText(b) }] };
}

const isPressed = (b: ButtonsState) => Boolean(b.pressedBy && b.pressedLabel != null);
const optionsText = (b: ButtonsState) => `Options: ${b.labels.join(' | ')}`;

/** The buttons (not pressed yet), the "pressed" note (pressed), or nothing (retired unpressed). */
export function buttonsBlock(b: ButtonsState): ButtonsActionsBlock | ContextBlock | null {
  if (isPressed(b)) return pressedNote(b);
  return b.expired ? null : buttonsActions(b);
}

/**
 * The block of a message that carries only buttons (no reply text): as buttonsBlock, but retired buttons leave their
 * labels as a grey note (the message can't be empty).
 */
export function buttonsOnlyBlock(b: ButtonsState): ButtonsActionsBlock | ContextBlock {
  return buttonsBlock(b) ?? { type: 'context', block_id: buttonsBlockId(b.id), elements: [{ type: 'mrkdwn', text: mrkdwnLabel(optionsText(b)) }] };
}

/** Plain-text fallback for a message that carries only buttons (no reply text). */
export function buttonsFallbackText(b: ButtonsState): string {
  return isPressed(b) ? pressedText(b) : optionsText(b);
}
