/**
 * Turn steps on the plan card: the lookups and other work a turn did itself ("Searched Slack", "Read a page"), shown
 * as tasks next to the subagent runs it started, and summed up in the finished card's title until its background
 * title arrives ("Searched Slack, read 2 pages"). Pure, unit-tested (card-render.test.ts).
 *
 * Only real work is a step. Bookkeeping (notes, reminders, watches, titles), responses (reply / react) and the
 * subagent tools are not: runs are tasks of their own, and a steer shows on the run's row. A turn with no step and no
 * run gets no card.
 */
import type { RunStatus } from './card-render.js';

export type StepStatus = 'in_progress' | 'complete' | 'error';

export interface CardStep {
  tool: string;
  status: StepStatus;
}

interface StepKind {
  /** Task title while it runs / once done. */
  live: string;
  done: string;
  /** Summary phrase for n steps of this kind ("read 2 pages"). */
  summary: (n: number) => string;
}

const times = (base: string) => (n: number) => (n === 1 ? base : `${base} ${n === 2 ? 'twice' : `${n} times`}`);
const count = (one: string, many: string) => (n: number) => (n === 1 ? one : many.replace('#', String(n)));

const KINDS: Record<string, StepKind> = {
  web_search: { live: 'Searching the web…', done: 'Searched the web', summary: times('searched the web') },
  slack_search: { live: 'Searching Slack…', done: 'Searched Slack', summary: times('searched Slack') },
  fetch_url: { live: 'Reading the page…', done: 'Read a page', summary: count('read a page', 'read # pages') },
  read_thread: { live: 'Reading the thread…', done: 'Read the thread', summary: times('read the thread') },
  read_public_thread: { live: 'Reading a Slack thread…', done: 'Read a Slack thread', summary: count('read a Slack thread', 'read # Slack threads') },
  read_channel: { live: 'Reading the channel…', done: 'Read the channel', summary: times('read the channel') },
  read_public_channel: { live: 'Reading a Slack channel…', done: 'Read a Slack channel', summary: count('read a Slack channel', 'read # Slack channels') },
  read_file: { live: 'Opening the file…', done: 'Opened a file', summary: count('opened a file', 'opened # files') },
  create_file: { live: 'Writing a file…', done: 'Wrote a file', summary: count('wrote a file', 'wrote # files') },
  read_canvas: { live: 'Reading the canvas…', done: 'Read a canvas', summary: count('read a canvas', 'read # canvases') },
  create_canvas: { live: 'Writing a canvas…', done: 'Wrote a canvas', summary: count('wrote a canvas', 'wrote # canvases') },
  edit_canvas: { live: 'Updating the canvas…', done: 'Updated a canvas', summary: count('updated a canvas', 'updated # canvases') },
};
/** Same kind of work under another tool name. */
const ALIASES: Record<string, string> = { ask_thread: 'read_thread', ask_file: 'read_file' };

const kindOf = (tool: string) => KINDS[ALIASES[tool] ?? tool];

/** True if a call of this tool is a step on the turn's card. */
export function isCardStep(tool: string): boolean {
  return Boolean(kindOf(tool));
}

/** The step's task title: the running label, or the done one. */
export function stepTitle(step: CardStep): string {
  const k = kindOf(step.tool);
  if (!k) return step.tool;
  return step.status === 'in_progress' ? k.live : k.done;
}

const plural = (n: number) => `${n} subagent${n === 1 ? '' : 's'}`;

/**
 * Short summary of what the card did, in order of first appearance: "searched Slack, read 2 pages, ran 3
 * subagents". Empty when there is nothing to sum up.
 */
export function summarizeSteps(steps: CardStep[], runs: { status: RunStatus }[] = []): string {
  const counts = new Map<string, number>();
  for (const s of steps) {
    const key = ALIASES[s.tool] ?? s.tool;
    if (KINDS[key]) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts].map(([key, n]) => KINDS[key]!.summary(n));
  if (runs.length) {
    const failed = runs.filter((r) => r.status === 'error').length;
    parts.push(`ran ${plural(runs.length)}${failed ? ` (${failed} failed)` : ''}`);
  }
  return parts.join(', ');
}

export const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
