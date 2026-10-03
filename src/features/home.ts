/** App Home: the user's own memory (with delete / forget everything) and, for the admin, moderation controls. */
import { env } from '../config.js';
import type { ActionContext } from '../core/actions.js';
import { slackCall } from '../core/slack.js';
import { log } from '../log.js';
import { deleteAllFacts, deleteFact, factLabel, listFacts, parseFactId } from './memory/store.js';
import { pendingBotReportsCount } from './bot-reports.js';
import { confirmDialog, pendingReportsCount } from './reports.js';
import { getState, listBlocks, setPaused } from './state.js';
import { isAdmin, mrkdwnEscape, requireAdmin, truncate } from './util.js';
import { listWorkspaceFacts } from './workspace.js';

const MAX_BLOCKS = 100;
const USER_FACTS_SHOWN = 25;
const PENDING_FACTS_SHOWN = 8;
const APPROVED_FACTS_SHOWN = 15;
const BLOCKS_SHOWN = 10;

const btn = (action_id: string, text: string, value: string, extra: object = {}) => ({
  type: 'button',
  action_id,
  text: { type: 'plain_text', text },
  value,
  ...extra,
});
const section = (text: string, accessory?: object) => ({ type: 'section', text: { type: 'mrkdwn', text }, ...(accessory ? { accessory } : {}) });
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const header = (text: string) => ({ type: 'header', text: { type: 'plain_text', text } });

export async function buildHomeBlocks(userId: string): Promise<unknown[]> {
  const blocks: unknown[] = [];
  const facts = await listFacts(userId);

  blocks.push(header('What I remember about you'));
  blocks.push(
    context(
      `Facts ${env.BOT_DISPLAY_NAME} uses to personalise answers to you. Only you can see this list. ` +
        'Deleting is permanent. You can also say "forget …" in a conversation.',
    ),
  );
  if (facts.length === 0) blocks.push(section("_I don't remember anything about you yet._"));
  for (const f of facts.slice(0, USER_FACTS_SHOWN)) {
    blocks.push(section(`\`${factLabel(f.id)}\` ${truncate(mrkdwnEscape(f.text), 2800)}`, btn('mem:delete', 'Delete', String(f.id))));
  }
  if (facts.length > USER_FACTS_SHOWN) blocks.push(context(`…and ${facts.length - USER_FACTS_SHOWN} more (oldest-used not shown).`));
  if (facts.length > 0) {
    blocks.push({
      type: 'actions',
      elements: [
        btn('mem:forget_all', 'Forget everything', 'all', {
          style: 'danger',
          confirm: confirmDialog('Forget everything?', `This permanently deletes all ${facts.length} facts I remember about you.`, 'Forget everything'),
        }),
      ],
    });
  }

  if (isAdmin(userId)) blocks.push(...(await adminBlocks()));
  return blocks.slice(0, MAX_BLOCKS);
}

async function adminBlocks(): Promise<unknown[]> {
  const [state, reports, botReports, pending, approved, blocked] = await Promise.all([
    getState(),
    pendingReportsCount(),
    pendingBotReportsCount(),
    listWorkspaceFacts('pending'),
    listWorkspaceFacts('approved'),
    listBlocks(),
  ]);
  const out: unknown[] = [{ type: 'divider' }, header('Admin')];

  out.push(
    section(
      state.paused ? '*The bot is paused* for everyone except you.' : 'The bot is *running*.',
      state.paused
        ? btn('admin:resume', 'Resume', 'resume', { style: 'primary' })
        : btn('admin:pause', 'Pause everywhere', 'pause', {
            style: 'danger',
            confirm: confirmDialog('Pause the bot?', 'The bot stops responding to everyone except you until resumed.', 'Pause'),
          }),
    ),
  );
  out.push(
    section(
      `*Unreviewed reports:* ${reports}\n*Pending bot reports:* ${botReports}` +
        (state.disabledChannels.size ? `\n*Disabled channels:* ${[...state.disabledChannels].map((c) => `<#${c}>`).join(', ')}` : ''),
    ),
  );

  if (pending.length) {
    out.push(section('*Workspace facts awaiting approval*'));
    for (const f of pending.slice(0, PENDING_FACTS_SHOWN)) {
      out.push(section(`${truncate(mrkdwnEscape(f.text), 2800)}\n_proposed by <@${f.proposerId}>_`));
      out.push({
        type: 'actions',
        elements: [btn('fact:approve', 'Approve', String(f.id), { style: 'primary' }), btn('fact:reject', 'Reject', String(f.id))],
      });
    }
    if (pending.length > PENDING_FACTS_SHOWN) out.push(context(`…and ${pending.length - PENDING_FACTS_SHOWN} more.`));
  }

  out.push(section(`*Workspace facts* (${approved.length})`));
  if (approved.length === 0) out.push(context('None yet.'));
  for (const f of approved.slice(-APPROVED_FACTS_SHOWN)) {
    out.push(
      section(
        truncate(mrkdwnEscape(f.text), 2800),
        btn('fact:delete', 'Delete', String(f.id), {
          confirm: confirmDialog('Delete workspace fact?', truncate(f.text, 280), 'Delete'),
        }),
      ),
    );
  }
  if (approved.length > APPROVED_FACTS_SHOWN) out.push(context(`Showing the newest ${APPROVED_FACTS_SHOWN}.`));

  out.push(section(`*Blocked users* (${blocked.length})`));
  if (blocked.length === 0) out.push(context('Nobody is suspended or blocked.'));
  for (const b of blocked.slice(0, BLOCKS_SHOWN)) {
    const what = [b.suspended && 'suspended', b.sendBlocked && 'blocked from sending'].filter(Boolean).join(', ');
    out.push(section(`<@${b.userId}> — ${what}${b.reason ? `\n_${truncate(mrkdwnEscape(b.reason), 200)}_` : ''}`));
    const elements = [];
    if (b.suspended) elements.push(btn('mod:unsuspend', 'Unsuspend', b.userId, { style: 'primary' }));
    if (b.sendBlocked) elements.push(btn('mod:unblock_send', 'Allow sending', b.userId));
    out.push({ type: 'actions', elements });
  }
  if (blocked.length > BLOCKS_SHOWN) out.push(context(`…and ${blocked.length - BLOCKS_SHOWN} more.`));
  return out;
}

export async function publishHome(userId: string) {
  try {
    await slackCall('views.publish', { user_id: userId, view: { type: 'home', blocks: await buildHomeBlocks(userId) } });
  } catch (err) {
    log.error({ err, userId }, 'views.publish failed');
  }
}

/** mem:delete / mem:forget_all — always the clicking user's own memory. */
export async function handleMemoryAction(ctx: ActionContext) {
  if (ctx.actionId === 'mem:forget_all') await deleteAllFacts(ctx.userId);
  else if (ctx.actionId === 'mem:delete') {
    const id = parseFactId(ctx.value ?? '');
    if (id) await deleteFact(ctx.userId, id);
  }
  await publishHome(ctx.userId);
}

/** admin:pause / admin:resume */
export async function handleAdminAction(ctx: ActionContext) {
  if (!(await requireAdmin(ctx))) return;
  if (ctx.actionId === 'admin:pause') await setPaused(true);
  else if (ctx.actionId === 'admin:resume') await setPaused(false);
  await publishHome(ctx.userId);
}
