/**
 * Plan card rendering: a pure function of DB state → Slack message (blocks + text). No I/O here.
 */
// Shapes mirror @slack/types PlanBlock / TaskCardBlock (not a direct dependency).
export interface RichTextBlock {
  type: 'rich_text';
  elements: { type: 'rich_text_section'; elements: { type: 'text'; text: string }[] }[];
}
export interface TaskCardBlock {
  type: 'task_card';
  task_id: string;
  title: string;
  details?: RichTextBlock;
  output?: RichTextBlock;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
}
export interface PlanBlock {
  type: 'plan';
  title: string;
  tasks: TaskCardBlock[];
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
}

export interface CardRun {
  id: number;
  subagentTitle: string;
  status: RunStatus;
  isResume: boolean;
  details: string | null;
  steerNotes: string[];
  output: string | null;
  error: string | null;
}

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

function richText(text: string): RichTextBlock {
  return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] };
}

export function taskFor(run: CardRun): TaskCardBlock {
  const title = clip(`${run.isResume ? '↻ ' : ''}${run.subagentTitle}`, 120);
  const base = { type: 'task_card' as const, task_id: `run_${run.id}`, title };
  const steer = run.steerNotes.map((n) => `↪ ${clip(n, 80)}`);
  switch (run.status) {
    case 'queued':
      return { ...base, status: 'pending', details: richText(['Queued', ...steer].join('\n')) };
    case 'running': {
      const lines = [clip(run.details || 'Working…', 200), ...steer];
      return { ...base, status: 'in_progress', details: richText(lines.join('\n')) };
    }
    case 'complete':
      return { ...base, status: 'complete', output: richText(clip(run.output || 'Done', 200)) };
    case 'error':
      return { ...base, status: 'error', details: richText(clip(run.error || 'Failed', 200)) };
    case 'cancelled':
      return { ...base, status: 'error', details: richText('Cancelled') };
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
  blocks: (PlanBlock | ActionsBlock)[];
}

export function renderCard(card: CardState, runs: CardRun[]): RenderedCard {
  const sorted = [...runs].sort((a, b) => a.id - b.id);
  const anyActive = sorted.some((r) => isActive(r.status));
  const title = card.frozen ? frozenTitle(card.title, sorted.length) : liveTitle(sorted);
  const plan: PlanBlock = { type: 'plan', title, tasks: sorted.map(taskFor) };
  const blocks: (PlanBlock | ActionsBlock)[] = [plan];
  if (anyActive && !card.frozen) {
    blocks.push({
      type: 'actions',
      block_id: `card_${card.id}_actions`,
      elements: [
        {
          type: 'button',
          action_id: STOP_ALL_ACTION,
          value: String(card.id),
          text: { type: 'plain_text', text: 'Stop all' },
          style: 'danger',
        },
      ],
    });
  }
  const text = [title, ...sorted.map((r) => `• ${r.isResume ? '↻ ' : ''}${r.subagentTitle} (${statusWord(r)})`)].join('\n');
  return { text, blocks };
}
