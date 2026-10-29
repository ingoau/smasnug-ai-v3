/**
 * `read_subagent_result` (front tool, tools.ts): a finished subagent's full result outside the synthesis turn. Only
 * the results turn gets the results in its context; later turns saw a one-line summary in <subagents>, so in prod the
 * front agent re-ran a sandbox job via message_subagent just to see its output, or asked ask_thread for a file id.
 * Scoped to subagents of the current thread. The formatting is pure (subagent-result.test.ts).
 */
import { sql } from '../db/index.js';
import { filesCreatedByRuns } from '../files/store.js';
import { fileListingLine, type FileListing } from '../files/format.js';
import { annotateTsDates } from '../context/format.js';
import { clipTokens, oneLine } from './util.js';

/** Token budget of the latest result (the synthesis turn's whole budget: one result here). */
export const RESULT_BUDGET = 12000;
/** Earlier runs listed (newest first) besides the latest one, each as one line. */
const EARLIER_RUNS = 4;

export interface ResultSubagent {
  id: string;
  title: string;
  status: string;
  ownerId: string;
  kind: string;
  sandbox: boolean;
  summary: string | null;
}

export interface ResultRun {
  id: number;
  status: string;
  instructions: string;
  result: string | null;
  error: string | null;
  details: string | null;
  isResume: boolean;
  finishedAt: Date | null;
}

/** The tool's text: status, the latest run's full result (clipped) and files, then earlier runs in one line each. */
export function formatSubagentResult(s: ResultSubagent, runs: ResultRun[], files: Map<number, FileListing[]>, budget = RESULT_BUDGET): string {
  const kind = s.kind === 'cursor' ? ' [coding agent, Cursor]' : s.sandbox ? ' [sandbox]' : '';
  const lines = [`${s.id} "${s.title}"${kind} (owner <@${s.ownerId}>) — subagent ${s.status}`];
  if (!runs.length) return [...lines, s.summary ? `Summary: ${s.summary}` : 'No runs yet.'].join('\n');
  // Newest first. A run still in progress is reported as such, with the latest finished one's result after it.
  const active = runs.find((r) => r.status === 'queued' || r.status === 'running');
  const latest = runs.find((r) => r.status !== 'queued' && r.status !== 'running');
  if (active) lines.push(`A run is ${active.status}${active.details ? `: ${oneLine(active.details, 120)}` : ''} (its result comes in a results turn).`);
  if (latest) {
    lines.push(`Latest finished run${latest.isResume ? ' (follow-up)' : ''} — ${latest.status.toUpperCase()}`, `Task: ${oneLine(latest.instructions, 300)}`);
    if (latest.status === 'complete')
      lines.push(`Result:\n${clipTokens(annotateTsDates(latest.result ?? '(empty)'), budget, 'head', `result truncated here; publish all of it with create_file(from_files) or a canvas with from_subagent "${s.id}"`)}`);
    else if (latest.status === 'cancelled') lines.push('Cancelled before finishing.');
    else lines.push(`Failed: ${latest.error ?? 'unknown error'}`);
    const made = files.get(latest.id) ?? [];
    if (made.length) lines.push(`Files it created (post with reply(files: [ids]); no need to read them):\n${made.map((f) => `- ${fileListingLine(f)}`).join('\n')}`);
  } else if (s.summary) lines.push(`Summary: ${s.summary}`);
  const earlier = runs.filter((r) => r !== active && r !== latest && r.status !== 'queued' && r.status !== 'running').slice(0, EARLIER_RUNS);
  if (earlier.length) {
    lines.push(
      `Earlier runs (newest first):\n${earlier
        .map((r) => {
          const made = files.get(r.id) ?? [];
          const what = r.status === 'complete' ? oneLine(r.result ?? '', 200) : r.status === 'cancelled' ? 'cancelled' : `failed: ${oneLine(r.error ?? 'unknown error', 120)}`;
          return `- ${r.status}: ${what}${made.length ? ` [files: ${made.map((f) => f.id).join(', ')}]` : ''}`;
        })
        .join('\n')}`,
    );
  }
  return lines.join('\n');
}

/** Load and format one subagent of this thread; a clear message (not an error) when it isn't one. */
export async function readSubagentResult(threadId: string, subagentId: string): Promise<string> {
  const id = subagentId.trim();
  const [s] = await sql<ResultSubagent[]>`
    select id, title, status, owner_id, kind, sandbox, summary from subagents where id = ${id} and thread_id = ${threadId}`;
  if (!s) return `No subagent "${id}" in this thread. Use an id from <subagents> or an earlier spawn_subagent result.`;
  const runs = await sql<ResultRun[]>`
    select id, status, instructions, result, error, details, is_resume, finished_at from runs
    where subagent_id = ${id} and thread_id = ${threadId} order by id desc limit ${EARLIER_RUNS + 2}`;
  const norm = runs.map((r) => ({ ...r, id: Number(r.id) }));
  const files = await filesCreatedByRuns(norm.map((r) => r.id));
  return formatSubagentResult(s, norm, files);
}
