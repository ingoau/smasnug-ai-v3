/** Admin-approved workspace knowledge: proposals, moderation-channel approval, deletion. */
import { env } from '../config.js';
import type { ActionContext } from '../core/actions.js';
import { isCodeChannelRoot } from '../core/events.js';
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
  /** Null: workspace-wide. Set: a channel rule, only shown on turns in that channel (memory/rules.ts). */
  channelId: string | null;
  /** A channel rule saved right away for the channel's creator (not the admin): rendered as their preference (memory/rules.ts). */
  setByOwner: boolean;
  status: 'pending' | 'approved' | 'rejected';
  modMessageTs: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export const WS_FACT_MAX_CHARS = 400;
export const PENDING_PROPOSALS_PER_USER = 5;

/**
 * Propose a workspace fact (or, with `channelId`, a rule for one channel). `autoApprove` (the proposer is the admin, or
 * the channel's creator for a channel rule: memory/tools.ts decides) saves it as approved right away, so a rule an
 * admin states applies from the next turn; anything else waits for the admin in the moderation channel. A creator's
 * rule (`setByOwner`; anyone can create a public channel) is also posted there, as a notice with a Remove button.
 */
export async function proposeWorkspaceFact(
  proposerId: string,
  text: string,
  sourceThread: string | null,
  opts: { channelId?: string | null; autoApprove?: boolean; setByOwner?: boolean } = {},
): Promise<string> {
  const channelId = opts.channelId ?? null;
  const where = channelId ? 'in this channel' : 'workspace-wide';
  const [dup] = await sql<{ id: number; status: string }[]>`
    select id, status from workspace_facts
    where lower(text) = lower(${text}) and channel_id is not distinct from ${channelId} and status in ('pending', 'approved')`;
  if (dup && (dup.status === 'approved' || !opts.autoApprove)) return 'That workspace fact is already known or awaiting approval.';
  if (opts.autoApprove) {
    const setByOwner = !!channelId && !!opts.setByOwner;
    const [fact] = dup
      ? await sql<WorkspaceFact[]>`
          update workspace_facts set status = 'approved', decided_at = now(), set_by_owner = ${setByOwner} where id = ${dup.id} returning *`
      : await sql<WorkspaceFact[]>`
          insert into workspace_facts (text, source_thread, proposer_id, channel_id, status, decided_at, set_by_owner)
          values (${text}, ${sourceThread}, ${proposerId}, ${channelId}, 'approved', now(), ${setByOwner}) returning *`;
    if (!channelId) await invalidateWorkspaceFacts();
    // The admin sees every rule nobody reviewed: a creator's rule goes to the moderation channel as a notice.
    if (setByOwner && fact) {
      try {
        const ts = fact.modMessageTs
          ? (await slackCall('chat.update', { channel: env.MOD_CHANNEL_ID, ts: fact.modMessageTs, text: ownerRuleText(fact), blocks: proposalBlocks(fact) }), fact.modMessageTs)
          : await postToModChannel(ownerRuleText(fact), proposalBlocks(fact), `wsfact:${fact.id}:owner`);
        if (ts && ts !== fact.modMessageTs) await sql`update workspace_facts set mod_message_ts = ${ts} where id = ${fact.id}`;
      } catch (err) {
        log.error({ err, factId: fact.id }, "posting the channel owner's rule failed");
      }
    }
    return `Saved (${where}); it applies from the next turn. The admin can remove it in App Home.`;
  }
  const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
    select count(*)::int as n from workspace_facts where proposer_id = ${proposerId} and status = 'pending'`;
  if (n >= PENDING_PROPOSALS_PER_USER)
    return `This user already has ${n} workspace facts awaiting approval; wait for those to be reviewed.`;

  const [fact] = await sql<WorkspaceFact[]>`
    insert into workspace_facts (text, source_thread, proposer_id, channel_id) values (${text}, ${sourceThread}, ${proposerId}, ${channelId}) returning *`;
  try {
    const ts = await postToModChannel(`Workspace fact proposed by <@${proposerId}>`, proposalBlocks(fact!), `wsfact:${fact!.id}`);
    if (ts) await sql`update workspace_facts set mod_message_ts = ${ts} where id = ${fact!.id}`;
  } catch (err) {
    log.error({ err, factId: fact!.id }, 'posting workspace fact proposal failed');
  }
  return `Sent to the admin for approval (${where}). It will be used once approved.`;
}

/** Approved rules for one channel, oldest first. */
export async function listChannelRules(channelId: string): Promise<Pick<WorkspaceFact, 'id' | 'text' | 'setByOwner'>[]> {
  return sql<Pick<WorkspaceFact, 'id' | 'text' | 'setByOwner'>[]>`
    select id, text, set_by_owner from workspace_facts where channel_id = ${channelId} and status = 'approved' order by id`;
}

function ownerRuleText(f: WorkspaceFact): string {
  return `Channel owner <@${f.proposerId}> set a rule for <#${f.channelId}>: ${mrkdwnEscape(f.text)}`;
}

async function sourceLink(sourceThread: string | null): Promise<string> {
  if (!sourceThread) return '';
  const i = sourceThread.indexOf(':');
  // A code channel's conversation (`…:0`) has no root message to link: point at the channel.
  if (isCodeChannelRoot(sourceThread.slice(i + 1))) return ` · <#${sourceThread.slice(0, i)}>`;
  try {
    const res = await slackCall<any>('chat.getPermalink', { channel: sourceThread.slice(0, i), message_ts: sourceThread.slice(i + 1) });
    return res.permalink ? ` · <${res.permalink}|source thread>` : '';
  } catch {
    return '';
  }
}

function proposalBlocks(f: WorkspaceFact, decided?: string): unknown[] {
  // A channel owner's rule is already in effect: the card informs, with a Remove button instead of approve / reject.
  const owner = f.setByOwner && f.status === 'approved';
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: owner
          ? `*Rule for <#${f.channelId}> set* by its creator <@${f.proposerId}> (in effect, shown to the bot as the owner's preference)\n${quote(f.text, 1000)}`
          : `*${f.channelId ? `Rule for <#${f.channelId}>` : 'Workspace fact'} proposed* by <@${f.proposerId}>\n${quote(f.text, 1000)}`,
      },
    },
  ];
  if (decided) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: decided }] });
  else if (owner)
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', action_id: 'fact:delete', text: { type: 'plain_text', text: 'Remove' }, style: 'danger', value: String(f.id) }],
    });
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
  if (f && status === 'approved' && !f.channelId) await invalidateWorkspaceFacts();
  return f;
}

export async function deleteWorkspaceFact(id: number): Promise<boolean> {
  return (await deleteWorkspaceFactRow(id)) != null;
}

async function deleteWorkspaceFactRow(id: number): Promise<WorkspaceFact | undefined> {
  const [f] = await sql<WorkspaceFact[]>`delete from workspace_facts where id = ${id} returning *`;
  if (f) await invalidateWorkspaceFacts();
  return f;
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
    const f = await deleteWorkspaceFactRow(id);
    // Its moderation card (a channel owner's rule notice, or a decided proposal) says it's gone.
    if (f?.modMessageTs && env.MOD_CHANNEL_ID)
      await slackCall('chat.update', {
        channel: env.MOD_CHANNEL_ID,
        ts: f.modMessageTs,
        text: `Workspace fact removed: ${mrkdwnEscape(f.text)}`,
        blocks: proposalBlocks(f, `Removed by <@${ctx.userId}>${await sourceLink(f.sourceThread)}`),
      }).catch((err) => log.warn({ err }, 'updating proposal message failed'));
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
