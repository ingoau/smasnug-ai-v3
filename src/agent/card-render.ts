/**
 * Plan card rendering: a pure function of DB state → Slack message (blocks + text). No I/O here.
 *
 * One card per bot message (Slack shows one plan per message): the turn's own steps (card-steps.ts) and the runs it
 * started are the tasks of one plan block, above the reply text. Once nothing in it is in progress (or it was frozen
 * after its synthesis), the card collapses to one titled line: a `context` block "✓ *Title* · searched Slack, read 2
 * pages". Slack documents no collapsed state for plan blocks, so the collapsed card is a plain context line.
 */
import { capitalize, stepTitle, summarizeSteps, type CardStep } from './card-steps.js';
import { markdownToRich, type RichTextElement, type RichTextInline } from './rich-text.js';
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';
import { buttonsBlock, type ButtonsActionsBlock, type ButtonsState, type ContextBlock } from './reply-buttons.js';
import { MAX_FALLBACK_TEXT, MAX_MESSAGE_BLOCKS, replyBlocks, type ReplyBlock } from './slack-markdown.js';

// Shapes mirror @slack/types PlanBlock / TaskCardBlock (not a direct dependency).
export interface RichTextBlock {
  type: 'rich_text';
  elements: RichTextElement[];
}
export interface URLSource {
  type: 'url';
  url: string;
  text: string;
}
export interface TaskCardBlock {
  type: 'task_card';
  task_id: string;
  title: string;
  details?: RichTextBlock;
  output?: RichTextBlock;
  sources?: URLSource[];
  status: 'pending' | 'in_progress' | 'complete' | 'error';
}
export interface PlanBlock {
  type: 'plan';
  block_id?: string;
  title: string;
  tasks: TaskCardBlock[];
}
export interface MarkdownBlock {
  type: 'markdown';
  block_id?: string;
  text: string;
}
export interface ActionsBlock {
  type: 'actions';
  block_id?: string;
  elements: {
    type: 'button';
    action_id: string;
    value: string;
    text: { type: 'plain_text'; text: string };
    style?: 'danger' | 'primary';
  }[];
}

export type RunStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';

export interface CardState {
  id: number;
  /** Set by set_card_title on synthesis. */
  title: string | null;
  frozen: boolean;
  /** The card lives in this reply message: its text is re-rendered above the plan. null/undefined = standalone. */
  replyText?: string | null;
  /** Quick-reply buttons of that reply (kept on every re-render: the buttons, or the "pressed" note). */
  buttons?: ButtonsState | null;
  /** The turn's own steps (lookups), in call order. */
  steps?: CardStep[];
}

export interface CardRun {
  id: number;
  subagentTitle: string;
  status: RunStatus;
  isResume: boolean;
  details: string | null;
  steerNotes: string[];
  /** One-line summary. */
  output: string | null;
  /** Full result text (markdown). */
  result?: string | null;
  error: string | null;
  /** URLs the run used (fetch_url targets, web-search sources). */
  sources?: { url: string; title?: string }[];
  /** When the run started / finished (for the duration shown in the task title). */
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

/** Compact duration: "8s", "1m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** How long the run has been going (running) or took (finished); null if it never started. */
export function runDuration(run: Pick<CardRun, 'status' | 'startedAt' | 'finishedAt'>, now = Date.now()): string | null {
  if (!run.startedAt || run.status === 'queued') return null;
  const end = run.status === 'running' ? now : (run.finishedAt?.getTime() ?? now);
  return formatDuration(end - run.startedAt.getTime());
}

/**
 * How much of each run's result the card shows. Slack: a plan holds at most 50 tasks and a message at most 50
 * blocks (a plan is one block); no per-task output limit is documented, so we keep the whole card compact and
 * shrink excerpts as runs pile up.
 */
export function outputBudget(runCount: number): { maxChars: number; maxLines: number; sources: number } {
  if (runCount <= 3) return { maxChars: 600, maxLines: 8, sources: 5 };
  if (runCount <= 6) return { maxChars: 300, maxLines: 4, sources: 3 };
  if (runCount <= 12) return { maxChars: 150, maxLines: 2, sources: 2 };
  return { maxChars: 0, maxLines: 0, sources: 0 };
}

/** Slack's plan block limit. */
export const MAX_PLAN_TASKS = 50;

export const STOP_ALL_ACTION = 'card:stop_all';

export const isActive = (s: RunStatus) => s === 'queued' || s === 'running';

const plural = (n: number) => `${n} subagent${n === 1 ? '' : 's'}`;

export function liveTitle(runs: Pick<CardRun, 'status'>[]): string {
  const active = runs.filter((r) => isActive(r.status)).length;
  return active > 0 ? `Running ${plural(active)}` : `Ran ${plural(runs.length)}`;
}

/** Title for a frozen card: the agent's set_card_title value as written, else "Ran N subagents". */
export function frozenTitle(title: string | null | undefined, runCount: number): string {
  const t = title?.trim();
  return t ? t : `Ran ${plural(runCount)}`;
}

function clip(s: string, max: number) {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function richText(text: string, style?: { bold?: boolean }): RichTextBlock {
  const el: RichTextInline = { type: 'text', text, ...(style ? { style } : {}) };
  return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [el] }] };
}

function sourceLabel(s: { url: string; title?: string }): string {
  if (s.title?.trim()) return clip(s.title, 80);
  try {
    const u = new URL(s.url);
    return clip(`${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`, 80);
  } catch {
    return clip(s.url, 80);
  }
}

/** Result output: the summary in bold, then an excerpt of the result within the budget. */
function resultOutput(run: CardRun, budget: ReturnType<typeof outputBudget>): RichTextBlock {
  const summary = clip(run.output || 'Done', 200);
  const head: RichTextElement = { type: 'rich_text_section', elements: [{ type: 'text', text: summary, style: { bold: true } }] };
  const result = (run.result ?? '').trim();
  if (!budget.maxChars || !result || result === run.output?.trim()) return { type: 'rich_text', elements: [head] };
  return { type: 'rich_text', elements: [head, ...markdownToRich(result, { maxChars: budget.maxChars, maxLines: budget.maxLines })] };
}

export function taskFor(run: CardRun, budget = outputBudget(1)): TaskCardBlock {
  const duration = runDuration(run);
  const title = `${clip(`${run.isResume ? '↻ ' : ''}${run.subagentTitle}`, 110)}${duration ? ` · ${duration}` : ''}`;
  const base = { type: 'task_card' as const, task_id: `run_${run.id}`, title };
  const steer = run.steerNotes.map((n) => `↪ ${clip(n, 80)}`);
  const sources = (run.sources ?? []).slice(0, budget.sources).map((s) => ({ type: 'url' as const, url: s.url, text: sourceLabel(s) }));
  const withSources = <T extends TaskCardBlock>(t: T): T => (sources.length ? { ...t, sources } : t);
  return withSources(taskBody(run, base, steer, budget));
}

function taskBody(run: CardRun, base: Pick<TaskCardBlock, 'type' | 'task_id' | 'title'>, steer: string[], budget: ReturnType<typeof outputBudget>): TaskCardBlock {
  switch (run.status) {
    case 'queued':
      return { ...base, status: 'pending', details: richText(['Queued', ...steer].join('\n')) };
    case 'running': {
      const lines = [clip(run.details || 'Working…', 200), ...steer];
      return { ...base, status: 'in_progress', details: richText(lines.join('\n')) };
    }
    case 'complete':
      return { ...base, status: 'complete', output: resultOutput(run, budget) };
    case 'error':
      return { ...base, status: 'error', output: richText(clip(run.error || 'Failed', 200)) };
    case 'cancelled':
      return { ...base, status: 'error', output: richText('Cancelled') };
  }
}

function statusWord(run: CardRun) {
  switch (run.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return run.details ? `running: ${clip(run.details, 80)}` : 'running';
    case 'complete':
      return run.output ? `done: ${clip(run.output, 80)}` : 'done';
    case 'error':
      return `failed: ${clip(run.error || 'error', 60)}`;
    case 'cancelled':
      return 'cancelled';
  }
}

export interface RenderedCard {
  text: string;
  blocks: (MarkdownBlock | ReplyBlock | PlanBlock | ActionsBlock | ButtonsActionsBlock | ContextBlock)[];
}

/** True when nothing on the card is still going (no step in progress, no run queued / running) or it was frozen. */
export function isCollapsed(card: Pick<CardState, 'frozen' | 'steps'>, runs: Pick<CardRun, 'status'>[]): boolean {
  return card.frozen || (!runs.some((r) => isActive(r.status)) && !(card.steps ?? []).some((s) => s.status === 'in_progress'));
}

const escapeMrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The collapsed card's line: the set_card_title title (frozen cards) with the summary of what it did, or the
 * summary alone ("Searched Slack, read 2 pages"), or "Ran N subagents".
 */
export function collapsedLine(card: Pick<CardState, 'frozen' | 'title' | 'steps'>, runs: Pick<CardRun, 'status'>[]): { title: string; summary: string } {
  const summary = summarizeSteps(card.steps ?? [], runs);
  const title = card.frozen ? card.title?.trim() : '';
  if (title) return { title, summary };
  if (summary) return { title: capitalize(summary), summary: '' };
  return { title: frozenTitle(null, runs.length), summary: '' };
}

/** Title of the expanded plan: the runs' title, else "Working…" while a step runs, else the summary. */
function expandedTitle(card: CardState, runs: CardRun[]): string {
  if (runs.length) return card.frozen ? frozenTitle(card.title, runs.length) : liveTitle(runs);
  if ((card.steps ?? []).some((s) => s.status === 'in_progress')) return 'Working…';
  return capitalize(summarizeSteps(card.steps ?? [])) || 'Done';
}

/** The card itself (one block): a plan with the steps and runs as tasks, or its collapsed line. */
export function renderCardBlock(card: CardState, runs: CardRun[]): PlanBlock | ContextBlock {
  const sorted = [...runs].sort((a, b) => a.id - b.id);
  const blockId = `card_${card.id}_plan`;
  if (isCollapsed(card, sorted)) {
    const { title, summary } = collapsedLine(card, sorted);
    const text = neutralizeBroadcasts(`✓ *${escapeMrkdwn(clip(title, 150))}*${summary ? ` · ${escapeMrkdwn(summary)}` : ''}`);
    return { type: 'context', block_id: blockId, elements: [{ type: 'mrkdwn', text }] };
  }
  const budget = outputBudget(sorted.length);
  const steps: TaskCardBlock[] = (card.steps ?? []).map((s, i) => ({ type: 'task_card', task_id: `step_${i + 1}`, title: stepTitle(s), status: s.status }));
  const tasks = [...steps, ...sorted.map((r) => taskFor(r, budget))].slice(-MAX_PLAN_TASKS);
  // Stable block ids so Slack treats each chat.update as the same blocks (keeps the plan expanded if the viewer opened it).
  return { type: 'plan', block_id: blockId, title: expandedTitle(card, sorted), tasks };
}

/** Plain-text summary of the card (the fallback text of a card without a reply). */
function cardText(card: CardState, runs: CardRun[]): string {
  const sorted = [...runs].sort((a, b) => a.id - b.id);
  if (isCollapsed(card, sorted)) {
    const { title, summary } = collapsedLine(card, sorted);
    return summary ? `${title} · ${summary}` : title;
  }
  const title = expandedTitle(card, sorted);
  return [title, ...(card.steps ?? []).map((s) => `• ${stepTitle(s)}`), ...sorted.map((r) => `• ${r.isResume ? '↻ ' : ''}${r.subagentTitle} (${statusWord(r)})`)].join('\n');
}

/**
 * The message a card lives in: [card, reply text, buttons / pressed note] when it lives in a reply, else the card
 * alone. With the plain-text fallback.
 */
export function renderCard(card: CardState, runs: CardRun[]): RenderedCard {
  // A card with nothing on it (no step, no run) shows nothing.
  const blocks: RenderedCard['blocks'] = runs.length || card.steps?.length ? [renderCardBlock(card, runs)] : [];
  const reply = card.replyText;
  if (reply != null) {
    // The reply exactly as delivered (slack-markdown.ts: prose as markdown, code as rich_text), leaving room for the
    // card and the buttons.
    const parts = replyBlocks(reply, { maxBlocks: MAX_MESSAGE_BLOCKS - 1 - (card.buttons ? 1 : 0) });
    parts.forEach((b, i) => blocks.push({ ...b, block_id: i === 0 ? `card_${card.id}_reply` : `card_${card.id}_reply_${i}` }));
    // The reply's buttons (or the note that replaced them) stay right under its text.
    if (card.buttons) blocks.push(buttonsBlock(card.buttons));
  }
  // Plain-text fallback: the reply's own text when the card lives in a reply, else a summary of the card.
  const text = neutralizeBroadcasts((reply != null ? reply : cardText(card, runs)).slice(0, MAX_FALLBACK_TEXT));
  return { text, blocks };
}
