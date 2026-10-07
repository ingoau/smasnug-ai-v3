/**
 * App Home pieces for code sandboxes (docs/sandbox.md §4.4, §6): a short disclosure for everyone, and for the admin
 * the month's spend, live sandboxes, the kill switches, the allowlist and live previews (Take down). The admin sees
 * the allowlist, never anyone's HCA result.
 */
import { env } from '../config.js';
import type { ActionContext } from '../core/actions.js';
import { sql } from '../db/index.js';
import { confirmDialog } from '../features/reports.js';
import { isAdmin, mrkdwnEscape, requireAdmin, truncate } from '../features/util.js';
import { budgetStatus } from './budget.js';
import { handleTakedown } from './preview/flow.js';
import { livePreviews } from './preview/store.js';
import { previewsConfigured, sandboxConfigured, sandboxSettings, setSandboxSetting } from './settings.js';

const ALLOWLIST_SHOWN = 15;
const PREVIEWS_SHOWN = 8;

const btn = (action_id: string, text: string, value: string, extra: object = {}) => ({ type: 'button', action_id, text: { type: 'plain_text', text }, value, ...extra });
const section = (text: string, accessory?: object) => ({ type: 'section', text: { type: 'mrkdwn', text }, ...(accessory ? { accessory } : {}) });
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

/** One line for everyone: where sandbox and preview data goes. */
export function sandboxDisclosureBlocks(): unknown[] {
  if (!sandboxConfigured()) return [];
  return [
    context(
      `*Code sandboxes:* when ${env.BOT_DISPLAY_NAME} runs code for you, the code and any files it uses go to Modal (US) for that task and are deleted when the task ends.` +
        (previewsConfigured() ? ' Live previews are published on Cloudflare, only after you accept its terms.' : ''),
    ),
  ];
}

export async function sandboxAdminBlocks(userId: string): Promise<unknown[]> {
  if (!sandboxConfigured() || !isAdmin(userId)) return [];
  const [settings, budget, [live], allow, previews] = await Promise.all([
    sandboxSettings(),
    budgetStatus(),
    sql<{ n: number }[]>`select count(*)::int as n from sandboxes where state in ('creating', 'running', 'resuming')`,
    sql<{ userId: string; addedBy: string; note: string | null }[]>`select user_id, added_by, note from sandbox_allowlist order by created_at desc`,
    previewsConfigured() ? livePreviews(PREVIEWS_SHOWN) : Promise.resolve([]),
  ]);
  const usd = (n: number | null) => (n == null ? 'n/a' : `$${n.toFixed(2)}`);
  const out: unknown[] = [{ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: 'Code sandboxes' } }];
  out.push(
    section(
      `*This month:* ${usd(budget.spentUsd)} of ${usd(budget.budgetUsd)} (estimate ${usd(budget.estUsd)}, Modal metered ${usd(budget.modalEnvUsd)}, workspace ${usd(budget.modalWorkspaceUsd)})` +
        `${budget.exhausted ? ' · *stopped until next month*' : ''}\n*Live sandboxes:* ${live?.n ?? 0}`,
    ),
  );
  out.push(
    section(
      settings.disabled ? '*Sandboxes are off* for everyone except you.' : 'Sandboxes are *on*.',
      settings.disabled ? btn('sbx:enable', 'Turn on', 'on', { style: 'primary' }) : btn('sbx:disable', 'Turn off', 'off', { style: 'danger', confirm: confirmDialog('Turn code sandboxes off?', 'Running sandboxes are paused; nobody but you can start new ones.', 'Turn off') }),
    ),
  );
  if (previewsConfigured())
    out.push(
      section(
        settings.previewsDisabled ? '*Live previews are off.*' : 'Live previews are *on*.',
        settings.previewsDisabled ? btn('sbx:previews_on', 'Turn on', 'on', { style: 'primary' }) : btn('sbx:previews_off', 'Turn off', 'off'),
      ),
    );
  out.push(
    section(
      settings.accessMode === 'allowlist_only' ? '*Access:* allowlist only (Hack Club verification is not consulted).' : '*Access:* verified Hack Club identity, or on the allowlist.',
      settings.accessMode === 'allowlist_only' ? btn('sbx:mode_hca', 'Allow verified users', 'hca') : btn('sbx:mode_allowlist', 'Allowlist only', 'allowlist'),
    ),
  );
  out.push(section(`*Allowlist* (${allow.length})`, { type: 'users_select', action_id: 'sbx:allow_add', placeholder: { type: 'plain_text', text: 'Add someone' } }));
  if (!allow.length) out.push(context('Nobody yet.'));
  for (const a of allow.slice(0, ALLOWLIST_SHOWN)) out.push(section(`<@${a.userId}>${a.note ? ` — _${truncate(mrkdwnEscape(a.note), 200)}_` : ''}`, btn('sbx:allow_remove', 'Remove', a.userId)));
  if (allow.length > ALLOWLIST_SHOWN) out.push(context(`…and ${allow.length - ALLOWLIST_SHOWN} more.`));
  if (previewsConfigured()) {
    out.push(section(`*Live previews* (${previews.length})`));
    for (const p of previews)
      out.push(
        section(
          `*${truncate(mrkdwnEscape(p.title), 100)}* for <@${p.requesterId}>: ${p.url ?? ''} · expires ${p.expiresAt?.toISOString().slice(11, 16) ?? '?'} UTC`,
          btn('sbx:takedown', 'Take down', p.id, { style: 'danger', confirm: confirmDialog('Take down this preview?', 'Deletes the site with its temporary Cloudflare token and ends the preview.', 'Take down') }),
        ),
      );
  }
  return out;
}

/** sbx:* (admin only). */
export async function handleSandboxAdminAction(ctx: ActionContext, publishHome: (userId: string) => Promise<void>): Promise<void> {
  if (!(await requireAdmin(ctx))) return;
  switch (ctx.actionId) {
    case 'sbx:enable':
      await setSandboxSetting('disabled', false);
      break;
    case 'sbx:disable':
      await setSandboxSetting('disabled', true);
      break;
    case 'sbx:previews_on':
      await setSandboxSetting('previewsDisabled', false);
      break;
    case 'sbx:previews_off':
      await setSandboxSetting('previewsDisabled', true);
      break;
    case 'sbx:mode_hca':
      await setSandboxSetting('accessMode', 'hca_or_allowlist');
      break;
    case 'sbx:mode_allowlist':
      await setSandboxSetting('accessMode', 'allowlist_only');
      break;
    case 'sbx:allow_add':
      if (ctx.value && /^[UW][A-Z0-9]+$/.test(ctx.value))
        await sql`insert into sandbox_allowlist (user_id, added_by) values (${ctx.value}, ${ctx.userId}) on conflict (user_id) do nothing`;
      break;
    case 'sbx:allow_remove':
      if (ctx.value) await sql`delete from sandbox_allowlist where user_id = ${ctx.value}`;
      break;
    case 'sbx:takedown':
      await handleTakedown(ctx);
      break;
  }
  await publishHome(ctx.userId);
}
