/**
 * The automatic Status tab of a code channel (docs/code-channels.md, Status tab): a Block Kit view rendered from DB
 * state by code, no model call. This file is the pure part: data in, blocks out. status.ts loads the data and keeps
 * the tab up to date.
 *
 * Times are Slack date tokens (`<!date^…^{ago}|…>`), rendered by the viewer's client, so the blocks only change when
 * the state does (status.ts skips the setView when they're the same as last time).
 */
import type { CodeChannelKind } from './store.js';

/** The reserved view_key: the agent's set_view / remove_view refuse it. */
export const STATUS_VIEW_KEY = 'status';
export const STATUS_VIEW_NAME = 'Status';
/** Lists in the tab are capped (Block Kit: ≤ 3000 chars per section text, ≤ 100 blocks). */
export const STATUS_MAX_ACTIVE = 10;
export const STATUS_MAX_FINISHED = 5;
const TITLE_MAX = 80;
const ABOUT_MAX = 200;
const SECTION_TEXT_MAX = 3000;

export type StatusRunState = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';

export interface StatusRun {
  title: string;
  /** 'subagent' | 'sandbox' | 'coding agent'. */
  kind: string;
  status: StatusRunState;
  cancelRequested?: boolean;
  /** Started running (null while queued). */
  startedAt: Date | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** Started from a thread under a channel message rather than the channel's top-level conversation. */
  inThread: boolean;
}

export interface StatusInput {
  kind: CodeChannelKind;
  brief: string | null;
  /** Permalink of the origin message (fork / adopted), when known. */
  originPermalink?: string | null;
  openedBy: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  warnedAt: Date | null;
  /** When the sweep would archive it with no further messages. */
  archivesAt?: Date | null;
  /** The conversation waits on a reply from this user. */
  waitingOn?: string | null;
  /** send_message confirmations still pending in the channel's conversations. */
  pendingConfirmations?: number;
  active: StatusRun[];
  /** Newest first. */
  finished: StatusRun[];
}

/** Escape Slack mrkdwn control characters in untrusted text. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** First non-empty line, collapsed and cut to `max` chars (with …). */
export function firstLine(s: string | null | undefined, max: number): string {
  const line = (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const fallbackDate = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
/** "3 minutes ago" etc., rendered by Slack. */
export const ago = (d: Date) => `<!date^${Math.floor(d.getTime() / 1000)}^{ago}|${fallbackDate(d)}>`;
/** "Nov 17 at 10:02", rendered by Slack in the viewer's timezone. */
export const when = (d: Date) => `<!date^${Math.floor(d.getTime() / 1000)}^{date_short_pretty} at {time}|${fallbackDate(d)}>`;

function kindLine(i: StatusInput): string {
  const about = firstLine(i.brief, ABOUT_MAX);
  const from = i.originPermalink ? `<${i.originPermalink}|this message>` : 'a thread';
  if (i.kind === 'task') return `*Task:* ${about ? escapeMrkdwn(about) : '(no brief)'}`;
  if (i.kind === 'fork') return `*Forked* from ${from}`;
  return i.originPermalink ? `*Adopted* (opened in Slack from ${from})` : '*Adopted* (opened in Slack)';
}

const STATE_LABEL: Record<StatusRunState, string> = { queued: 'queued', running: 'running', complete: 'done', error: 'failed', cancelled: 'cancelled' };
const STATE_ICON: Record<StatusRunState, string> = { queued: ':hourglass_flowing_sand:', running: ':arrows_counterclockwise:', complete: ':white_check_mark:', error: ':x:', cancelled: ':no_entry_sign:' };

function runLine(r: StatusRun): string {
  const title = escapeMrkdwn(firstLine(r.title, TITLE_MAX) || 'Subagent');
  const where = r.inThread ? ' · in a thread' : '';
  if (r.status === 'queued') return `${STATE_ICON.queued} *${title}* · ${r.kind} · queued ${ago(r.createdAt)}${where}`;
  if (r.status === 'running') {
    const state = r.cancelRequested ? 'cancelling' : 'running';
    return `${STATE_ICON.running} *${title}* · ${r.kind} · ${state}, started ${ago(r.startedAt ?? r.createdAt)}${where}`;
  }
  const end = r.finishedAt ?? r.startedAt ?? r.createdAt;
  return `${STATE_ICON[r.status]} *${title}* · ${r.kind} · ${STATE_LABEL[r.status]} ${ago(end)}${where}`;
}

/** Join lines into one section text within Slack's limit, saying how many were left out. */
function capText(lines: string[]): string {
  const out: string[] = [];
  let len = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    if (len + line.length + 1 > SECTION_TEXT_MAX - 40) {
      out.push(`…and ${lines.length - k} more`);
      break;
    }
    out.push(line);
    len += line.length + 1;
  }
  return out.join('\n');
}

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

/** The Status tab's blocks (pure). */
export function renderStatusBlocks(i: StatusInput): unknown[] {
  const blocks: unknown[] = [];
  blocks.push({ type: 'header', text: { type: 'plain_text', text: 'About this channel' } });
  blocks.push(section(kindLine(i)));
  const meta = [
    ...(i.openedBy ? [`Opened by <@${i.openedBy}>`] : []),
    `created ${when(i.createdAt)}`,
    `last activity ${ago(i.lastActivityAt)}`,
  ];
  blocks.push(context(meta.join(' · ')));
  const notes: string[] = [];
  if (i.waitingOn) notes.push(`:speech_balloon: Waiting for a reply from <@${i.waitingOn}>`);
  if (i.pendingConfirmations) notes.push(`:envelope: ${i.pendingConfirmations} message${i.pendingConfirmations === 1 ? '' : 's'} waiting for confirmation`);
  if (i.warnedAt && i.archivesAt) notes.push(`:warning: Archives ${when(i.archivesAt)} unless someone writes here`);
  else if (i.archivesAt) notes.push(`Archives after a week without messages (${when(i.archivesAt)} at the earliest)`);
  if (notes.length) blocks.push(context(notes.join('\n')));

  blocks.push({ type: 'divider' });
  const active = i.active.slice(0, STATUS_MAX_ACTIVE);
  const moreActive = i.active.length - active.length;
  const activeLines = active.map(runLine);
  if (moreActive > 0) activeLines.push(`…and ${moreActive} more`);
  blocks.push(section(`*Running*${i.active.length ? ` (${i.active.length})` : ''}\n${activeLines.length ? capText(activeLines) : 'Nothing running.'}`));

  const finished = i.finished.slice(0, STATUS_MAX_FINISHED);
  if (finished.length) blocks.push(section(`*Recently finished*\n${capText(finished.map(runLine))}`));
  return blocks;
}

/** Plain-text summary of the run kind for a subagent row. */
export function runKindLabel(s: { sandbox?: boolean | null; kind?: string | null }): string {
  if (s.sandbox) return 'sandbox';
  if (s.kind === 'cursor') return 'coding agent';
  return 'subagent';
}
