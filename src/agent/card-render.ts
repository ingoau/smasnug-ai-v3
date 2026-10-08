/**
 * Plan card rendering: a pure function of DB state → Slack message (blocks + text). No I/O here.
 *
 * One card per bot message (Slack shows one plan per message): the turn's own steps (card-steps.ts) and the runs it
 * started are the tasks of one plan block, above the reply text. The card is always a plan block, live or finished.
 * Once nothing in it is in progress (or it was frozen after its synthesis) it is finished: every task in its final
 * status (complete / error), titled with its background title (src/agent/titles.ts) or, until that arrives, the
 * summary of what it did ("Searched Slack, read 2 pages, worked on 3 tasks"). Slack itself shows a plan block collapsed
 * to its title and expands it on click (verified in the Slack client; the plan block docs don't mention it), so there
 * is no collapsing logic here: the finished plan still lists every step and run when opened.
 */
import { capitalize, stepTitle, summarizeSteps, type CardStep } from './card-steps.js';
import { cleanRichElements, markdownToRich, type RichTextElement, type RichTextInline } from './rich-text.js';
import { neutralizeBroadcasts } from '../pipeline/guidelines.js';
import { sliceUnits } from '../tools/util.js';
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
  /** Set in the background after the write-up (src/agent/titles.ts). */
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

/** Run details while it works (src/agent/child.ts): generic, so the plan title shows the task's own title instead. */
export const FIRST_STEP_DETAILS = 'Researching…';
export const THINKING_DETAILS = 'Thinking…';
export const WRITING_DETAILS = 'Writing up…';
const GENERIC_DETAILS = new Set([FIRST_STEP_DETAILS, THINKING_DETAILS, WRITING_DETAILS]);

const runTitle = (r: Pick<CardRun, 'subagentTitle'>) => r.subagentTitle?.trim() || 'Task';
const tasks = (n: number) => (n === 1 ? 'a task' : `${n} tasks`);

/**
 * Live title while runs are active, in terms of the work (users never see the word "subagent"): one active run →
 * what it is doing right now ("Searching Slack for “hackathon dates”"), or its title while it only thinks; several →
 * "Working on 3 tasks". None active: frozenTitle.
 */
export function liveTitle(runs: Pick<CardRun, 'status' | 'subagentTitle' | 'details'>[]): string {
  const active = runs.filter((r) => isActive(r.status));
  if (active.length > 1) return `Working on ${tasks(active.length)}`;
  const [only] = active;
  if (!only) return frozenTitle(null, runs);
  const details = only.status === 'running' ? only.details?.trim() : '';
  // A long step's elapsed time (child.ts withElapsed) doesn't make a generic label specific.
  return details && !GENERIC_DETAILS.has(details.replace(/ \(\d+s\)$/, '')) ? details : runTitle(only);
}

/** Title for a finished card: its background title (src/agent/titles.ts) as written, else the one run's title, else "Worked on N tasks". */
export function frozenTitle(title: string | null | undefined, runs: Pick<CardRun, 'subagentTitle'>[]): string {
  const t = title?.trim();
  if (t) return t;
  return runs.length === 1 ? runTitle(runs[0]!) : `Worked on ${tasks(runs.length)}`;
}

function clip(s: string, max: number) {
  const t = s.trim();
  return t.length > max ? `${sliceUnits(t, max - 1)}…` : t;
}

function richText(text: string, style?: { bold?: boolean }): RichTextBlock {
  const el: RichTextInline = { type: 'text', text, ...(style ? { style } : {}) };
  return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [el] }] };
}

/**
 * A task's details / output as Slack accepts it: no empty (or blank-edged) text elements, no empty sections or lists
 * (an empty text element makes Slack reject the whole message with invalid_blocks). Undefined when nothing visible
 * is left, so the field is omitted.
 */
function richField(block: RichTextBlock): RichTextBlock | undefined {
  const elements = cleanRichElements(block.elements);
  return elements.length ? { type: 'rich_text', elements } : undefined;
}

/** `t` clipped, or `fallback` when it is missing or blank. */
const clipOr = (t: string | null | undefined, fallback: string, max: number) => clip(t ?? '', max) || fallback;

function sourceLabel(s: { url: string; title?: string }): string {
  if (s.title?.trim()) return clip(s.title, 80);
  try {
    const u = new URL(s.url);
    return clip(`${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`, 80) || clip(s.url, 80);
  } catch {
    return clip(s.url, 80);
  }
}

/** Result output: the summary in bold, then an excerpt of the result within the budget. */
function resultOutput(run: CardRun, budget: ReturnType<typeof outputBudget>): RichTextBlock {
  const summary = clipOr(run.output, 'Done', 200);
  const head: RichTextElement = { type: 'rich_text_section', elements: [{ type: 'text', text: summary, style: { bold: true } }] };
  const result = (run.result ?? '').trim();
  if (!budget.maxChars || !result || result === run.output?.trim()) return { type: 'rich_text', elements: [head] };
  return { type: 'rich_text', elements: [head, ...markdownToRich(result, { maxChars: budget.maxChars, maxLines: budget.maxLines })] };
}

export function taskFor(run: CardRun, budget = outputBudget(1)): TaskCardBlock {
  const duration = runDuration(run);
  const title = `${clip(`${run.isResume ? '↻ ' : ''}${runTitle(run)}`, 110)}${duration ? ` · ${duration}` : ''}`;
  const base = { type: 'task_card' as const, task_id: `run_${run.id}`, title };
  const steer = run.steerNotes.filter((n) => n?.trim()).map((n) => `↪ ${clip(n, 80)}`);
  const sources = (run.sources ?? [])
    .filter((s) => typeof s?.url === 'string' && s.url.trim())
    .slice(0, budget.sources)
    .map((s) => ({ type: 'url' as const, url: s.url, text: sourceLabel(s) }));
  const withSources = <T extends TaskCardBlock>(t: T): T => (sources.length ? { ...t, sources } : t);
  const task = taskBody(run, base, steer, budget);
  // Every rich text field cleaned; one with nothing visible left is omitted rather than sent empty.
  for (const k of ['details', 'output'] as const) {
    if (!task[k]) continue;
    const f = richField(task[k]);
    if (f) task[k] = f;
    else delete task[k];
  }
  return withSources(task);
}

function taskBody(run: CardRun, base: Pick<TaskCardBlock, 'type' | 'task_id' | 'title'>, steer: string[], budget: ReturnType<typeof outputBudget>): TaskCardBlock {
  switch (run.status) {
    case 'queued':
      return { ...base, status: 'pending', details: richText(['Queued', ...steer].join('\n')) };
    case 'running': {
      const lines = [clipOr(run.details, 'Working…', 200), ...steer];
      return { ...base, status: 'in_progress', details: richText(lines.join('\n')) };
    }
    case 'complete':
      return { ...base, status: 'complete', output: resultOutput(run, budget) };
    case 'error':
      return { ...base, status: 'error', output: richText(clipOr(run.error, 'Failed', 200)) };
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

/** True when the card is finished: frozen (after its synthesis), or no step in progress and no run queued / running. */
export function isFinished(card: Pick<CardState, 'frozen' | 'steps'>, runs: Pick<CardRun, 'status'>[]): boolean {
  return card.frozen || (!runs.some((r) => isActive(r.status)) && !(card.steps ?? []).some((s) => s.status === 'in_progress'));
}

/** Longest plan title we send (Slack documents none for the block; plan_update chunks allow 256). */
const MAX_PLAN_TITLE = 150;

/**
 * The plan's title. Live: what the active run is doing ("Searching Slack for …"), or "Working on N tasks", while
 * runs are active (liveTitle), else "Working…" (a step is running). Finished: the card's background title
 * (src/agent/titles.ts), else the summary of what it did ("Searched Slack, read 2 pages, worked on 3 tasks"), else
 * frozenTitle. It is what a viewer sees of the finished card until they expand it.
 */
export function planTitle(card: Pick<CardState, 'frozen' | 'title' | 'steps'>, runs: Pick<CardRun, 'status' | 'subagentTitle' | 'details'>[]): string {
  let title: string;
  if (!isFinished(card, runs)) title = runs.some((r) => isActive(r.status)) ? liveTitle(runs) : 'Working…';
  else title = card.title?.trim() || capitalize(summarizeSteps(card.steps ?? [], runs)) || frozenTitle(null, runs);
  return neutralizeBroadcasts(clip(title, MAX_PLAN_TITLE));
}

/**
 * The card itself (one block): a plan with the steps, then the runs, as tasks. Finished, no step is left in
 * progress (a step still running when its turn ended never failed: complete).
 */
export function renderCardBlock(card: CardState, runs: CardRun[]): PlanBlock {
  const sorted = [...runs].sort((a, b) => a.id - b.id);
  const finished = isFinished(card, sorted);
  const budget = outputBudget(sorted.length);
  const steps: TaskCardBlock[] = (card.steps ?? []).map((s, i) => {
    const status = finished && s.status === 'in_progress' ? 'complete' : s.status;
    return { type: 'task_card', task_id: `step_${i + 1}`, title: stepTitle({ ...s, status }), status };
  });
  const tasks = [...steps, ...sorted.map((r) => taskFor(r, budget))].slice(-MAX_PLAN_TASKS);
  // Stable block ids so Slack treats each chat.update as the same blocks (keeps the plan expanded if the viewer opened it).
  return { type: 'plan', block_id: `card_${card.id}_plan`, title: planTitle(card, sorted), tasks };
}

/** Plain-text summary of the card (the fallback text of a card without a reply). */
function cardText(card: CardState, runs: CardRun[]): string {
  const sorted = [...runs].sort((a, b) => a.id - b.id);
  const block = renderCardBlock(card, sorted);
  const steps = block.tasks.filter((t) => t.task_id.startsWith('step_')).map((t) => `• ${t.title}`);
  return [block.title, ...steps, ...sorted.map((r) => `• ${r.isResume ? '↻ ' : ''}${r.subagentTitle} (${statusWord(r)})`)].join('\n');
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
