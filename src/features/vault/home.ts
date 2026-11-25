/**
 * Vault in App Home (docs/vault.md): the user's credentials (delete each), "Add login" / "Add API key" modals, and the
 * last uses. The same modal answers a request_credential card ("Add it"). Modal submissions are sealed in transit
 * (transport.ts); ingress can't return modal errors, so a bad form is reopened with the error (the submission's
 * trigger_id), or DMed if that fails.
 */
import type { ActionContext } from '../../core/actions.js';
import { slackCall } from '../../core/slack.js';
import { log } from '../../log.js';
import { confirmDialog } from '../reports.js';
import { mrkdwnEscape, respond, truncate } from '../util.js';
import { decide, loadApproval, replaceCard } from './approvals.js';
import { audit, recentAudit } from './audit.js';
import { vaultConfigured } from './crypto.js';
import { deleteCredential, getCredential, listCredentials, normalizeName, parseDomains, saveCredential, validName, VaultError, type Credential } from './store.js';
import { validTotp } from './totp.js';
import { openViewState } from './transport.js';

export const VAULT_MODAL_CALLBACK = 'vaultm:save';
const ADD_LOGIN = 'vault:add_login';
const ADD_KEY = 'vault:add_key';
const DELETE = 'vault:delete';

type PublishHome = (userId: string) => Promise<void>;
type FormType = 'login' | 'api_key';
interface Meta {
  type: FormType;
  approvalId?: string;
}

const btn = (action_id: string, text: string, value: string, extra: object = {}) => ({ type: 'button', action_id, text: { type: 'plain_text', text }, value, ...extra });

function ago(d: Date | null): string {
  if (!d) return 'never used';
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 60) return `used ${Math.max(1, m)} min ago`;
  if (m < 48 * 60) return `used ${Math.round(m / 60)} h ago`;
  return `used ${Math.round(m / 1440)} d ago`;
}

function credentialLine(c: Credential): string {
  const type = c.kind === 'login' ? `login${c.meta.totp ? ' + 2FA' : ''}` : 'API key';
  const where = c.meta.domains?.length ? c.meta.domains.join(', ') : '_no website: sandbox file only_';
  const by = c.meta.savedBy === 'agent' ? ' · saved by the agent' : '';
  return `\`${mrkdwnEscape(c.name)}\` · ${type} · ${mrkdwnEscape(where)}\n_${ago(c.lastUsedAt)}${by}_`;
}

export async function vaultHomeBlocks(userId: string): Promise<unknown[]> {
  if (!vaultConfigured()) return [];
  const creds = (await listCredentials(userId, ['token', 'login'])).slice(0, 15);
  const uses = await recentAudit(userId, 5);
  const out: unknown[] = [
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: 'Your credentials' } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            'Logins and API keys the agent can use for you, stored encrypted. It never sees them: code adds them to one request, ' +
            'one browser field or one sandbox file, and you approve each use (or for 10 minutes in a thread). Only you can use yours.',
        },
      ],
    },
  ];
  if (creds.length === 0) out.push({ type: 'section', text: { type: 'mrkdwn', text: '_No credentials yet._' } });
  for (const c of creds) {
    out.push({
      type: 'section',
      text: { type: 'mrkdwn', text: credentialLine(c) },
      accessory: btn(DELETE, 'Delete', c.id, { style: 'danger', confirm: confirmDialog(`Delete ${c.name}?`, 'The agent can no longer use it. This is permanent.', 'Delete') }),
    });
  }
  out.push({ type: 'actions', elements: [btn(ADD_LOGIN, 'Add login', 'login'), btn(ADD_KEY, 'Add API key / secret', 'api_key')] });
  if (uses.length) {
    const lines = uses.map((u) => {
      const when = `<!date^${Math.floor(new Date(u.at).getTime() / 1000)}^{date_short_pretty} {time}|${new Date(u.at).toISOString()}>`;
      const host = typeof u.detail?.host === 'string' ? ` ${u.detail.host}` : typeof u.detail?.tool === 'string' ? ` ${u.detail.tool}` : '';
      return `${when} · \`${mrkdwnEscape(u.credentialName)}\` · ${u.action.replace(/_/g, ' ')}${mrkdwnEscape(host)} · ${u.outcome}`;
    });
    out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: truncate(`*Recent uses*\n${lines.join('\n')}`, 2900) }] });
  }
  return out;
}

function input(blockId: string, label: string, o: { optional?: boolean; initial?: string; placeholder?: string; hint?: string; multiline?: boolean; max?: number } = {}) {
  return {
    type: 'input',
    block_id: blockId,
    optional: Boolean(o.optional),
    label: { type: 'plain_text', text: label },
    ...(o.hint ? { hint: { type: 'plain_text', text: o.hint } } : {}),
    element: {
      type: 'plain_text_input',
      action_id: 'v',
      ...(o.initial ? { initial_value: o.initial } : {}),
      ...(o.placeholder ? { placeholder: { type: 'plain_text', text: o.placeholder } } : {}),
      ...(o.multiline ? { multiline: true } : {}),
      ...(o.max ? { max_length: o.max } : {}),
    },
  };
}

export function credentialModal(meta: Meta, prefill: { name?: string; website?: string; username?: string; note?: string; header?: string; error?: string } = {}) {
  const blocks: unknown[] = [];
  if (prefill.error) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:warning: ${mrkdwnEscape(prefill.error)}` } });
  blocks.push(input('name', 'Name', { initial: prefill.name ?? '', placeholder: meta.type === 'login' ? 'github' : 'openai-key', hint: 'How you and the agent refer to it. Lowercase letters, digits, - _ .', max: 40 }));
  blocks.push(
    input('website', 'Website', {
      optional: true,
      initial: prefill.website ?? '',
      placeholder: meta.type === 'login' ? 'github.com' : 'api.openai.com',
      hint: 'Where it may be used (subdomains included). Leave empty for something not tied to a website: the agent then only gets it as a file in its sandbox and is told not to read it.',
      max: 300,
    }),
  );
  if (meta.type === 'login') {
    blocks.push(input('username', 'Username or email', { initial: prefill.username ?? '', max: 300 }));
    blocks.push(input('password', 'Password', { max: 1000, hint: 'Slack shows what you type here; nobody else sees this form.' }));
    blocks.push(input('totp', '2FA (TOTP) secret', { optional: true, max: 500, placeholder: 'JBSWY3DPEHPK3PXP or otpauth://totp/…', hint: 'The setup key behind the QR code. The bot generates the 6-digit codes itself.' }));
  } else {
    // Slack caps plain_text_input max_length at 3000.
    blocks.push(input('secret', 'Secret', { max: 3000, multiline: true, hint: 'The API key, token or other secret.' }));
    blocks.push(input('header', 'How to send it', { optional: true, initial: prefill.header ?? '', placeholder: 'Authorization: Bearer', hint: 'Header name and prefix for web requests, e.g. "X-Api-Key" or "Authorization: token". Default: Authorization: Bearer.', max: 100 }));
  }
  blocks.push(input('note', 'Note for the agent', { optional: true, initial: prefill.note ?? '', placeholder: 'read-only token for my repos', max: 300 }));
  return {
    type: 'modal',
    callback_id: VAULT_MODAL_CALLBACK,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: meta.type === 'login' ? 'Add a login' : 'Add an API key' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

async function openModal(ctx: ActionContext, view: object): Promise<boolean> {
  if (!ctx.triggerId) return false;
  try {
    await slackCall('views.open', { trigger_id: ctx.triggerId, view });
    return true;
  } catch (err) {
    log.warn({ err }, 'vault modal open failed');
    return false;
  }
}

/** `key`: idempotency key of the triggering interaction (its trigger_id). */
async function dm(userId: string, text: string, key: string) {
  await slackCall('chat.postMessage', { channel: userId, text }, { idempotencyKey: `vault-dm:${userId}:${key}` }).catch((err) => log.warn({ err }, 'vault DM failed'));
}

/** Idempotency key for a DM answering this interaction. */
const interactionKey = (ctx: ActionContext) => ctx.triggerId ?? `${ctx.actionId}:${ctx.messageTs ?? ''}:${ctx.value ?? ''}`;

/** Block actions with the vault: prefix that aren't approvals. */
export async function handleVaultHomeAction(ctx: ActionContext, publishHome: PublishHome): Promise<void> {
  if (!vaultConfigured()) return;
  if (ctx.actionId === ADD_LOGIN || ctx.actionId === ADD_KEY) {
    const ok = await openModal(ctx, credentialModal({ type: ctx.actionId === ADD_LOGIN ? 'login' : 'api_key' }));
    if (!ok) await dm(ctx.userId, 'Slack took too long to open the form. Press the button again in a moment.', interactionKey(ctx));
    return;
  }
  if (ctx.actionId === DELETE) {
    const c = await deleteCredential(ctx.userId, ctx.value ?? '');
    if (c) await audit({ ownerId: ctx.userId, credentialId: c.id, credentialName: c.name, action: 'deleted', outcome: 'ok', detail: { by: 'user' } });
    await publishHome(ctx.userId);
    return;
  }
  if (ctx.actionId === 'vault:add_requested') {
    const row = await loadApproval(ctx.value);
    if (!row || row.ownerId !== ctx.userId) {
      await respond(ctx.responseUrl, { response_type: 'ephemeral', replace_original: false, text: 'Only the person asked can add this.' });
      return;
    }
    if (row.status !== 'pending') return replaceCard(ctx, row, row.status);
    const { openFor } = await import('./crypto.js');
    const { sql } = await import('../../db/index.js');
    const [r] = await sql<{ payloadEnc: Buffer | null }[]>`select payload_enc from vault_approvals where id = ${row.id}`;
    const p = r?.payloadEnc ? (JSON.parse(openFor(row.ownerId, r.payloadEnc)) as { name: string; type: FormType; domains: string[] }) : null;
    const ok = await openModal(ctx, credentialModal({ type: p?.type ?? 'api_key', approvalId: row.id }, { name: p?.name ?? '', website: p?.domains?.join(', ') ?? '' }));
    if (!ok) await respond(ctx.responseUrl, { response_type: 'ephemeral', replace_original: false, text: 'Slack took too long to open the form. Press "Add it" again.' });
  }
}

function val(values: Record<string, Record<string, any>> | undefined, block: string): string {
  const v = values?.[block]?.v?.value;
  return typeof v === 'string' ? v.trim() : '';
}

function parseHeader(raw: string): { header?: string; scheme?: string } | null {
  if (!raw) return {};
  const m = /^([A-Za-z0-9-]{1,60})(?:\s*:\s*(\S{0,30}))?$/.exec(raw.trim());
  if (!m) return null;
  return { header: m[1]!.toLowerCase(), scheme: m[2] ?? '' };
}

/** view_submission for the credential modal. */
export async function handleVaultModal(ctx: ActionContext, publishHome: PublishHome): Promise<void> {
  if (ctx.body?.type !== 'view_submission' || !vaultConfigured()) return;
  let meta: Meta;
  try {
    meta = JSON.parse(ctx.value ?? '{}');
  } catch {
    return;
  }
  if (meta.type !== 'login' && meta.type !== 'api_key') return;
  const values = openViewState(ctx.body).values;
  const name = normalizeName(val(values, 'name'));
  const websiteRaw = val(values, 'website');
  const note = val(values, 'note');
  const header = val(values, 'header');
  const username = val(values, 'username');
  const keep = { name, website: websiteRaw, note, header, username };
  const fail = async (error: string) => {
    // Reopen with the error (secrets are not refilled), else DM.
    if (!(await openModal(ctx, credentialModal(meta, { ...keep, error })))) await dm(ctx.userId, `Your credential wasn't saved: ${error}`, interactionKey(ctx));
  };
  if (!validName(name)) return fail('Names use lowercase letters, digits, "-", "_" or "." (up to 40 characters).');
  const domains = parseDomains(websiteRaw);
  if (websiteRaw && domains.length === 0) return fail('Website should be a domain like github.com.');
  const existing = await getCredential(ctx.userId, name);
  if (existing && existing.kind !== (meta.type === 'login' ? 'login' : 'token')) return fail(`You already have something called "${name}" of another type.`);
  try {
    let saved: Credential;
    if (meta.type === 'login') {
      const password = values?.password?.v?.value ?? '';
      const totp = val(values, 'totp');
      if (!username || !password) return fail('Username and password are both needed.');
      if (totp && !validTotp(totp)) return fail("That 2FA secret isn't a valid TOTP key (base32) or otpauth:// link.");
      saved = await saveCredential({
        ownerId: ctx.userId,
        name,
        kind: 'login',
        meta: { domains, totp: Boolean(totp), savedBy: 'user', ...(note ? { note } : {}) },
        secret: { username, password, ...(totp ? { totp } : {}) },
      });
    } else {
      const secret = (values?.secret?.v?.value ?? '').trim();
      if (!secret) return fail('The secret is empty.');
      const h = parseHeader(header);
      if (!h) return fail('"How to send it" should look like "X-Api-Key" or "Authorization: Bearer".');
      saved = await saveCredential({ ownerId: ctx.userId, name, kind: 'token', meta: { domains, savedBy: 'user', ...h, ...(note ? { note } : {}) }, secret: { value: secret } });
    }
    await audit({ ownerId: ctx.userId, credentialId: saved.id, credentialName: name, action: existing ? 'replaced' : 'created', outcome: 'ok', detail: { by: 'user' } });
  } catch (err) {
    return fail(err instanceof VaultError ? err.message : 'Something went wrong saving it. Try again.');
  }
  if (meta.approvalId) {
    const row = await loadApproval(meta.approvalId);
    if (row && row.ownerId === ctx.userId && row.status === 'pending') {
      const done = await decide(row, 'approved', 'once');
      if (done) await replaceCard(null, done, 'approved');
    }
  }
  await publishHome(ctx.userId).catch(() => {});
}
