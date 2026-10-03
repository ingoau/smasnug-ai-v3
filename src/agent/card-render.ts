/**
 * Plan card rendering: a pure function of DB state → Slack message (blocks + text). No I/O here.
 */
import { markdownToRich, type RichTextElement, type RichTextInline } from './rich-text.js';
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';
import { buttonsBlock, type ButtonsActionsBlock, type ButtonsState, type ContextBlock } from './reply-buttons.js';

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
const TITLE_MAX = 40;

export const isActive = (s: RunStatus) => s === 'queued' || s === 'running';

const plural = (n: number) => `${n} subagent${n === 1 ? '' : 's'}`;

export function liveTitle(runs: Pick<CardRun, 'status'>[]): string {
  const active = runs.filter((r) => isActive(r.status)).length;
  return active > 0 ? `Running ${plural(active)}` : `Ran ${plural(runs.length)}`;
}

/** Title for a frozen card: the agent's set_card_title value if present and short enough, else "Ran N subagents". */
export function frozenTitle(title: string | null | undefined, runCount: number, maxChars = TITLE_MAX): string {
  const t = title?.trim().replace(/\s+/g, ' ');
  if (t && t.length <= maxChars) return t;
  return `Ran ${plural(runCount)}`;
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
  blocks: (MarkdownBlock | PlanBlock | ActionsBlock | ButtonsActionsBlock | ContextBlock)[];
}

/** Same limits as reply.ts markdownMessage: 12k chars per markdown block, 3k for the `text` fallback. */
const MAX_MD = 11_500;
const MAX_TEXT = 3_000;

export function renderCard(card: CardState, runs: CardRun[]): RenderedCard {
  const sorted = [...runs].sort((a, b) => a.id - b.id);
  const title = card.frozen ? frozenTitle(card.title, sorted.length) : liveTitle(sorted);
  const budget = outputBudget(sorted.length);
  // Stable block ids so Slack treats each chat.update as the same blocks (keeps the plan expanded if the viewer opened it).
  const plan: PlanBlock = { type: 'plan', block_id: `card_${card.id}_plan`, title, tasks: sorted.slice(-MAX_PLAN_TASKS).map((r) => taskFor(r, budget)) };
  const blocks: RenderedCard['blocks'] = [];
  const reply = card.replyText;
  if (reply != null) blocks.push({ type: 'markdown', block_id: `card_${card.id}_reply`, text: reply.length > MAX_MD ? `${reply.slice(0, MAX_MD)}\n\n_[message truncated]_` : reply });
  // The reply's buttons (or the note that replaced them) stay right under its text, above the plan.
  if (reply != null && card.buttons) blocks.push(buttonsBlock(card.buttons));
  blocks.push(plan);
  // Plain-text fallback: the reply's own text when the card lives in a reply, else a summary of the plan.
  const text = neutralizeBroadcasts(
    reply != null ? reply.slice(0, MAX_TEXT) : [title, ...sorted.map((r) => `• ${r.isResume ? '↻ ' : ''}${r.subagentTitle} (${statusWord(r)})`)].join('\n'),
  );
  return { text, blocks };
}
