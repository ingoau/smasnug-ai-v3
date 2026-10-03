/** Admin-approved workspace knowledge: proposals, moderation-channel approval, deletion. */
import { env } from '../config.js';
import type { ActionContext } from '../core/actions.js';
import { slackCall } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { invalidateWorkspaceFacts } from './memory/render.js';
import { mrkdwnEscape, postToModChannel, quote, requireAdmin, ephemeral, fromAppHome } from './util.js';

export interface WorkspaceFact {
  id: number;
  text: string;
  sourceThread: string | null;
  proposerId: string;
  status: 'pending' | 'approved' | 'rejected';
  modMessageTs: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export const WS_FACT_MAX_CHARS = 400;
export const PENDING_PROPOSALS_PER_USER = 5;

export async function proposeWorkspaceFact(proposerId: string, text: string, sourceThread: string | null): Promise<string> {
  const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
    select count(*)::int as n from workspace_facts where proposer_id = ${proposerId} and status = 'pending'`;
  if (n >= PENDING_PROPOSALS_PER_USER)
    return `This user already has ${n} workspace facts awaiting approval; wait for those to be reviewed.`;
  const [dup] = await sql`select id from workspace_facts where lower(text) = lower(${text}) and status in ('pending', 'approved')`;
  if (dup) return 'That workspace fact is already known or awaiting approval.';

  const [fact] = await sql<WorkspaceFact[]>`
    insert into workspace_facts (text, source_thread, proposer_id) values (${text}, ${sourceThread}, ${proposerId}) returning *`;
  try {
    const ts = await postToModChannel(`Workspace fact proposed by <@${proposerId}>`, proposalBlocks(fact!), `wsfact:${fact!.id}`);
    if (ts) await sql`update workspace_facts set mod_message_ts = ${ts} where id = ${fact!.id}`;
  } catch (err) {
    log.error({ err, factId: fact!.id }, 'posting workspace fact proposal failed');
  }
  return 'Sent to the admin for approval. It will be used once approved.';
}

async function sourceLink(sourceThread: string | null): Promise<string> {
  if (!sourceThread) return '';
  const i = sourceThread.indexOf(':');
  try {
    const res = await slackCall<any>('chat.getPermalink', { channel: sourceThread.slice(0, i), message_ts: sourceThread.slice(i + 1) });
    return res.permalink ? ` · <${res.permalink}|source thread>` : '';
  } catch {
    return '';
  }
}

function proposalBlocks(f: WorkspaceFact, decided?: string): unknown[] {
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Workspace fact proposed* by <@${f.proposerId}>\n${quote(f.text, 1000)}` } },
  ];
  if (decided) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: decided }] });
  else
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'fact:approve', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', value: String(f.id) },
        { type: 'button', action_id: 'fact:reject', text: { type: 'plain_text', text: 'Reject' }, style: 'danger', value: String(f.id) },
      ],
    });
  return blocks;
}

export async function decideWorkspaceFact(id: number, status: 'approved' | 'rejected'): Promise<WorkspaceFact | undefined> {
  const [f] = await sql<WorkspaceFact[]>`
    update workspace_facts set status = ${status}, decided_at = now() where id = ${id} and status = 'pending' returning *`;
  if (f && status === 'approved') await invalidateWorkspaceFacts();
  return f;
}

export async function deleteWorkspaceFact(id: number): Promise<boolean> {
  const rows = await sql`delete from workspace_facts where id = ${id} returning status`;
  if (rows.length) await invalidateWorkspaceFacts();
  return rows.length > 0;
}

export async function listWorkspaceFacts(status: WorkspaceFact['status']): Promise<WorkspaceFact[]> {
  return sql<WorkspaceFact[]>`select * from workspace_facts where status = ${status} order by id`;
}

/** fact:approve / fact:reject / fact:delete — admin only. */
export async function handleFactAction(ctx: ActionContext, refreshHome: (userId: string) => Promise<void>) {
  if (!(await requireAdmin(ctx))) return;
  const id = Number(ctx.value);
  if (!Number.isSafeInteger(id)) return;
  const verb = ctx.actionId.slice('fact:'.length);

  if (verb === 'delete') {
    await deleteWorkspaceFact(id);
  } else if (verb === 'approve' || verb === 'reject') {
    const status = verb === 'approve' ? 'approved' : 'rejected';
    const f = await decideWorkspaceFact(id, status);
    if (!f) {
      if (!fromAppHome(ctx)) await ephemeral(ctx, 'That proposal was already decided.');
    } else if (f.modMessageTs && env.MOD_CHANNEL_ID) {
      const note = `${status === 'approved' ? 'Approved' : 'Rejected'} by <@${ctx.userId}>${await sourceLink(f.sourceThread)}`;
      await slackCall('chat.update', {
        channel: env.MOD_CHANNEL_ID,
        ts: f.modMessageTs,
        text: `Workspace fact ${status}: ${mrkdwnEscape(f.text)}`,
        blocks: proposalBlocks(f, note),
      }).catch((err) => log.warn({ err }, 'updating proposal message failed'));
    }
  }
  if (fromAppHome(ctx)) await refreshHome(ctx.userId);
}
