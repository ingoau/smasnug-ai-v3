/**
 * Connectors in App Home (docs/mcp-custom-connectors.md, "App Home"): each enabled connector with Connect /
 * Disconnect, and once connected the three permission knobs plus "Edit actions" (per-tool overrides in a modal). The
 * admin section enables / disables catalog definitions, shows the catalog file's status and switches "Add connector"
 * (custom.ts: connectors people add themselves, listed with a Remove button) on or off.
 *
 * Actions use the `conn:` prefix, modals `connm:` (their submissions are sealed in transit, vault/transport.ts).
 * Ingress can't return modal errors, so a bad form is reopened with the error (the submission's trigger_id), or DMed.
 */
import { env } from '../../config.js';
import type { ActionContext } from '../../core/actions.js';
import { slackCall } from '../../core/slack.js';
import { log } from '../../log.js';
import { errMsg } from '../../tools/util.js';
import { hasAgreed } from '../privacy.js';
import { confirmDialog } from '../reports.js';
import { mrkdwnEscape, requireAdmin, truncate } from '../util.js';
import { audit } from '../vault/audit.js';
import { deleteCredential, getCredential, VaultError } from '../vault/store.js';
import { openViewState } from '../vault/transport.js';
import { catalogWithFlags, connectorsConfigured, enabledConnector, enabledConnectors, setConnectorEnabled } from './catalog.js';
import { addCustomConnector, customConnectorsAllowed, isCustomSlug, MAX_CUSTOM_CONNECTORS, removeCustomConnector, setCustomConnectorsAllowed, type CustomInput } from './custom.js';
import { ConnectorError, finishOAuth, getConnection, isConnected, listServerTools, pendingAuthUrl, saveApiKeyConnection, startOAuth, type Connection } from './connection.js';
import { classifyTool, CLASS_LABELS, isMode, MODE_LABELS, MODES, parseOAuthBlob, TOOL_CLASSES, type ConnectorDef, type Mode, type ToolClass } from './logic.js';
import { deleteSettings, getSettings, invalidateTools, revokeConnection, setKnob, setOverrides } from './settings.js';
import { connectorTools } from './tools.js';

export const CONN_ACTION_PREFIX = 'conn:';
export const CONN_MODAL_PREFIX = 'connm:';
const CONNECT = 'conn:connect';
const DISCONNECT = 'conn:disconnect';
const PASTE = 'conn:paste';
const SIGNIN = 'conn:signin';
const KNOB = 'conn:knob:';
const EDIT_ACTIONS = 'conn:edit_actions';
const ADMIN_TOGGLE = 'conn:admin_toggle';
const ADMIN_CUSTOM = 'conn:admin_custom';
const ADD = 'conn:add';
const REMOVE = 'conn:remove';
const ADD_MODAL = 'connm:add';
const KEY_MODAL = 'connm:key';
const CODE_MODAL = 'connm:code';
const ACTIONS_MODAL = 'connm:actions';

// Catalog connectors shown on Home; the user's own (at most MAX_CUSTOM_CONNECTORS) are always shown after them.
const CONNECTORS_SHOWN = 10;
const ADMIN_DEFS_SHOWN = 15;
const MODAL_TOOLS_SHOWN = 90;

type PublishHome = (userId: string) => Promise<void>;

const btn = (action_id: string, text: string, value: string, extra: object = {}) => ({ type: 'button', action_id, text: { type: 'plain_text', text }, value, ...extra });
const ctxBlock = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const opt = (text: string, value: string) => ({ text: { type: 'plain_text', text: truncate(text, 75) }, value });

function knobSelect(slug: string, cls: ToolClass, mode: Mode) {
  const options = MODES.map((m) => opt(`${CLASS_LABELS[cls]}: ${MODE_LABELS[m]}`, `${slug}|${m}`));
  return { type: 'static_select', action_id: `${KNOB}${cls}`, options, initial_option: options[MODES.indexOf(mode)] };
}

function authLabel(def: ConnectorDef): string {
  return def.auth.type === 'oauth' ? 'sign in' : 'API key';
}

/** The user's section (empty when the vault is off or nothing is enabled). */
export async function connectorsHomeBlocks(userId: string): Promise<unknown[]> {
  if (!connectorsConfigured()) return [];
  const all = await enabledConnectors(userId);
  const catalogDefs = all.filter((d) => !isCustomSlug(d.slug));
  const customDefs = all.filter((d) => isCustomSlug(d.slug));
  const defs = [...catalogDefs.slice(0, CONNECTORS_SHOWN), ...customDefs];
  const canAdd = (await customConnectorsAllowed()) && customDefs.length < MAX_CUSTOM_CONNECTORS;
  if (defs.length === 0 && !canAdd) return [];
  const out: unknown[] = [
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: 'Connectors' } },
    ctxBlock(
      'Connect your own accounts on other services. The agent can then use them, only in conversations where *you* are the one asking, never for anyone else. ' +
        'For reading, changing and deleting, pick: *Always allow*, *Auto-check* (a second model reads the thread to confirm you asked for exactly that), *Ask me* (a private card each time) or *Never*.',
    ),
  ];
  for (const def of defs) {
    const conn = await getConnection(userId, def.slug).catch(() => null);
    const connected = isConnected(conn);
    const pending = !connected ? pendingAuthUrl(conn) : null;
    const status = connected ? ':large_green_circle: connected' : pending ? ':hourglass: waiting for your code' : 'not connected';
    const oauthOff = def.auth.type === 'oauth' && !env.MCP_OAUTH_REDIRECT_URL;
    const custom = isCustomSlug(def.slug);
    const origin = custom ? ` · added by you · ${mrkdwnEscape(new URL(def.url).host)}` : '';
    const remove = custom
      ? [btn(REMOVE, 'Remove', def.slug, { confirm: confirmDialog(`Remove ${truncate(def.name, 60)}?`, 'It is disconnected and removed with its settings. The agent can no longer use it.', 'Remove') })]
      : [];
    const accessory = connected
      ? btn(DISCONNECT, 'Disconnect', def.slug, { style: 'danger', confirm: confirmDialog(`Disconnect ${def.name}?`, 'The agent can no longer use it. Anything running stops.', 'Disconnect') })
      : oauthOff
        ? undefined
        : btn(CONNECT, pending ? 'Start over' : 'Connect', def.slug, pending ? {} : { style: 'primary' });
    out.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(`*${mrkdwnEscape(def.name)}* · ${status}${origin}${def.description ? `\n${mrkdwnEscape(def.description)}` : ''}${oauthOff ? '\n_Sign-in isn’t set up on this bot yet._' : ''}`, 2900) },
      ...(accessory ? { accessory } : {}),
    });
    if (pending) {
      out.push({ type: 'actions', elements: [btn(SIGNIN, 'Open sign-in page', def.slug, { url: pending }), btn(PASTE, 'Paste code', def.slug, { style: 'primary' }), ...remove] });
    } else if (connected) {
      const s = await getSettings(userId, def.slug);
      const n = Object.keys(s.overrides).length;
      out.push({ type: 'actions', elements: [...TOOL_CLASSES.map((c) => knobSelect(def.slug, c, s[c])), btn(EDIT_ACTIONS, n ? `Edit actions (${n} set)` : 'Edit actions', def.slug), ...remove] });
    } else if (remove.length) out.push({ type: 'actions', elements: remove });
  }
  if (catalogDefs.length > CONNECTORS_SHOWN) out.push(ctxBlock(`…and ${catalogDefs.length - CONNECTORS_SHOWN} more connectors not shown.`));
  if (canAdd)
    out.push(
      { type: 'actions', elements: [btn(ADD, 'Add connector', 'add')] },
      ctxBlock('Add any remote MCP server (an https URL) that you sign in to or have an API key for. Only you can see and use the ones you add.'),
    );
  return out;
}

/** Admin: the catalog file and enable / disable per definition. */
export async function connectorsAdminBlocks(): Promise<unknown[]> {
  const { status, enabled } = await catalogWithFlags();
  if (!connectorsConfigured() && status.defs.length === 0) return [];
  const customOn = await customConnectorsAllowed();
  const out: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: customOn ? '*Add connector* is *on*: people can add their own MCP servers (each only for themselves).' : '*Add connector* is *off*: only the catalog below; connectors people added stop working.' },
      accessory: customOn
        ? btn(ADMIN_CUSTOM, 'Turn off', 'off', { confirm: confirmDialog('Turn off "Add connector"?', 'Nobody can add their own connectors, and the ones they added stop working until you turn it on again. They are kept.', 'Turn off') })
        : btn(ADMIN_CUSTOM, 'Turn on', 'on', { style: 'primary' }),
    },
    { type: 'section', text: { type: 'mrkdwn', text: '*Connectors catalog*' } },
  ];
  const state = status.state === 'missing' ? 'no file (empty catalog)' : status.state === 'error' ? 'unreadable' : `${status.defs.length} definition(s)`;
  const notes = [`\`${mrkdwnEscape(env.CONNECTORS_FILE)}\`: ${state}`];
  if (!connectorsConfigured()) notes.push(':warning: VAULT_SECRET_KEY is not set: connectors are off.');
  if (status.defs.some((d) => d.auth.type === 'oauth') && !env.MCP_OAUTH_REDIRECT_URL) notes.push(':warning: MCP_OAUTH_REDIRECT_URL is not set: OAuth connectors can’t be connected.');
  if (status.errors.length) notes.push(`Skipped entries:\n${status.errors.slice(0, 5).map((e) => `• ${mrkdwnEscape(e)}`).join('\n')}${status.errors.length > 5 ? `\n…and ${status.errors.length - 5} more` : ''}`);
  out.push(ctxBlock(truncate(notes.join('\n'), 2900)));
  for (const d of status.defs.slice(0, ADMIN_DEFS_SHOWN)) {
    const on = enabled.has(d.slug);
    out.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(`*${mrkdwnEscape(d.name)}* (\`${d.slug}\`) · ${on ? 'enabled' : 'disabled'}\n${mrkdwnEscape(new URL(d.url).host)} · ${authLabel(d)}`, 2900) },
      accessory: on
        ? btn(ADMIN_TOGGLE, 'Disable', `${d.slug}|off`, { confirm: confirmDialog(`Disable ${d.name}?`, 'Nobody can use it until it is enabled again. Connections are kept.', 'Disable') })
        : btn(ADMIN_TOGGLE, 'Enable', `${d.slug}|on`, { style: 'primary' }),
    });
  }
  if (status.defs.length > ADMIN_DEFS_SHOWN) out.push(ctxBlock(`…and ${status.defs.length - ADMIN_DEFS_SHOWN} more in the file.`));
  return out;
}

// --- modals ---------------------------------------------------------------------------------------------------------

/** Slack's limit for a plain_text_input's max_length. */
const PLAIN_TEXT_INPUT_MAX = 3000;

function input(blockId: string, label: string, o: { hint?: string; placeholder?: string; multiline?: boolean; max?: number; initial?: string; optional?: boolean } = {}) {
  return {
    type: 'input',
    block_id: blockId,
    ...(o.optional ? { optional: true } : {}),
    label: { type: 'plain_text', text: label },
    ...(o.hint ? { hint: { type: 'plain_text', text: truncate(o.hint, 1900) } } : {}),
    element: {
      type: 'plain_text_input',
      action_id: 'v',
      ...(o.placeholder ? { placeholder: { type: 'plain_text', text: o.placeholder } } : {}),
      ...(o.multiline ? { multiline: true } : {}),
      ...(o.max ? { max_length: Math.min(o.max, PLAIN_TEXT_INPUT_MAX) } : {}),
      ...(o.initial ? { initial_value: o.initial } : {}),
    },
  };
}

const errorBlock = (error?: string) => (error ? [{ type: 'section', text: { type: 'mrkdwn', text: `:warning: ${mrkdwnEscape(error)}` } }] : []);
const modalTitle = (s: string) => ({ type: 'plain_text', text: truncate(s, 24) });

type AddPrefill = Partial<Pick<CustomInput, 'name' | 'url' | 'description' | 'auth' | 'header'>>;

/** "Add connector": a remote MCP server of the user's own. */
export function addModal(prefill: AddPrefill = {}, error?: string) {
  const authOptions = [opt('Sign in (OAuth)', 'oauth'), opt('API key or token', 'api_key')];
  return {
    type: 'modal',
    callback_id: ADD_MODAL,
    private_metadata: '{}',
    title: modalTitle('Add connector'),
    submit: { type: 'plain_text', text: 'Add' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      ...errorBlock(error),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Connect a remote MCP server (an https URL; local and stdio servers are not supported). Only you can see and use it. ' +
            "What the server says is treated as untrusted, and you pick what the agent may do with it once it's connected. Only add servers you trust.",
        },
      },
      input('name', 'Name', { max: 60, initial: prefill.name, placeholder: 'Acme CRM' }),
      input('url', 'Server URL', { max: 500, initial: prefill.url, placeholder: 'https://mcp.example.com/mcp' }),
      input('description', 'What it is for', { max: 300, optional: true, initial: prefill.description, hint: 'Helps the agent know when to use it.' }),
      {
        type: 'input',
        block_id: 'auth',
        label: { type: 'plain_text', text: 'How you sign in' },
        element: { type: 'radio_buttons', action_id: 'v', options: authOptions, initial_option: authOptions[prefill.auth === 'api_key' ? 1 : 0] },
      },
      input('header', 'Header for the key', {
        max: 60,
        optional: true,
        initial: prefill.header,
        placeholder: 'Authorization',
        hint: 'API keys only. Leave empty for "Authorization: Bearer <key>"; otherwise the key is sent as the value of this header.',
      }),
    ],
  };
}

export function keyModal(def: ConnectorDef, error?: string) {
  const help = def.auth.type === 'api_key' ? def.auth.help : undefined;
  return {
    type: 'modal',
    callback_id: KEY_MODAL,
    private_metadata: JSON.stringify({ slug: def.slug }),
    title: modalTitle(`Connect ${def.name}`),
    submit: { type: 'plain_text', text: 'Connect' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      ...errorBlock(error),
      { type: 'section', text: { type: 'mrkdwn', text: truncate(`${help ? `${mrkdwnEscape(help)}\n\n` : ''}Your key is stored encrypted and only ever sent to ${mrkdwnEscape(new URL(def.url).host)}. The agent never sees it.`, 2900) } },
      input('key', 'API key', { max: PLAIN_TEXT_INPUT_MAX, hint: 'Slack shows what you type here; nobody else sees this form.' }),
    ],
  };
}

export function codeModal(def: ConnectorDef, authUrl: string | null, error?: string) {
  return {
    type: 'modal',
    callback_id: CODE_MODAL,
    private_metadata: JSON.stringify({ slug: def.slug }),
    title: modalTitle(`Connect ${def.name}`),
    submit: { type: 'plain_text', text: 'Connect' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      ...errorBlock(error),
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `After you approve access${authUrl ? ` on <${authUrl}|the sign-in page>` : ''}, you land on a page that shows a code. Copy it and paste it here.` },
      },
      input('code', 'Code', { max: PLAIN_TEXT_INPUT_MAX, placeholder: 'abc123….xyz' }),
    ],
  };
}

function actionsModalBase(def: ConnectorDef, blocks: unknown[], withSubmit: boolean) {
  return {
    type: 'modal',
    callback_id: ACTIONS_MODAL,
    private_metadata: JSON.stringify({ slug: def.slug }),
    title: modalTitle(`${def.name} actions`),
    ...(withSubmit ? { submit: { type: 'plain_text', text: 'Save' } } : {}),
    close: { type: 'plain_text', text: withSubmit ? 'Cancel' : 'Close' },
    blocks,
  };
}

async function actionsModal(userId: string, def: ConnectorDef, conn: Connection) {
  // fresh: the owner asked now, so a remembered failed listing is retried.
  const [tools, s] = await Promise.all([connectorTools(userId, def, conn, undefined, { fresh: true }), getSettings(userId, def.slug)]);
  if (tools.length === 0) return actionsModalBase(def, [ctxBlock('This server lists no actions.')], false);
  const blocks: unknown[] = [ctxBlock('Each action uses the setting for its kind (reading / changing / deleting) unless you pick something else here.')];
  for (const t of tools.slice(0, MODAL_TOOLS_SHOWN)) {
    const cls = classifyTool(def, t);
    const def0 = opt(`Default (${MODE_LABELS[s[cls]]})`, 'default');
    const options = [def0, ...MODES.map((m) => opt(MODE_LABELS[m], m))];
    const cur = s.overrides[t.name];
    blocks.push({
      type: 'input',
      block_id: `t:${t.name}`.slice(0, 255),
      optional: true,
      label: { type: 'plain_text', text: truncate(t.name, 2000) },
      hint: { type: 'plain_text', text: truncate(`${CLASS_LABELS[cls]}. ${t.description ?? ''}`, 300) },
      element: { type: 'static_select', action_id: 'v', options, initial_option: cur ? options[MODES.indexOf(cur) + 1] : def0 },
    });
  }
  if (tools.length > MODAL_TOOLS_SHOWN) blocks.push(ctxBlock(`…and ${tools.length - MODAL_TOOLS_SHOWN} more (they use the defaults).`));
  return actionsModalBase(def, blocks, true);
}

// --- handlers -------------------------------------------------------------------------------------------------------

async function openModal(triggerId: string | undefined, view: object): Promise<string | null> {
  if (!triggerId) return null;
  try {
    const res = await slackCall<any>('views.open', { trigger_id: triggerId, view });
    return res?.view?.id ?? '';
  } catch (err) {
    log.warn({ err }, 'connector modal open failed');
    return null;
  }
}

async function dm(userId: string, text: string, blocks?: unknown[]) {
  await slackCall('chat.postMessage', { channel: userId, text, ...(blocks ? { blocks } : {}) }).catch((err) => log.warn({ err }, 'connector DM failed'));
}

function slugOf(value: string | undefined): string {
  return (value ?? '').split('|')[0] ?? '';
}

async function connectOAuth(ctx: ActionContext, def: ConnectorDef, publishHome: PublishHome): Promise<void> {
  try {
    const r = await startOAuth(ctx.userId, def);
    await revokeConnection(ctx.userId, def.slug);
    if (r.status === 'connected') {
      await audit({ ownerId: ctx.userId, credentialName: `mcp.${def.slug}`, action: 'connector_connected', outcome: 'ok', detail: { connector: def.slug } });
      await dm(ctx.userId, `${def.name} is connected.`);
    } else {
      await dm(ctx.userId, `Connect ${def.name}: open the sign-in page, approve access, then copy the code you're shown and press "Paste code".`, [
        { type: 'section', text: { type: 'mrkdwn', text: `*Connect ${mrkdwnEscape(def.name)}*\n1. Open the sign-in page and approve access.\n2. Copy the code you're shown.\n3. Press *Paste code* and paste it.` } },
        { type: 'actions', elements: [btn(SIGNIN, 'Open sign-in page', def.slug, { url: r.url }), btn(PASTE, 'Paste code', def.slug, { style: 'primary' })] },
        ctxBlock('The link works for 30 minutes. Only you can finish this sign-in.'),
      ]);
    }
  } catch (err) {
    log.warn({ err, slug: def.slug }, 'connector OAuth start failed');
    await dm(ctx.userId, `Couldn't start connecting ${def.name}: ${err instanceof ConnectorError || err instanceof VaultError ? err.message : errMsg(err)}`);
  }
  await publishHome(ctx.userId);
}

/** Remove one of the user's own connectors: its connection (vault credential), grants, settings, caches and the row. */
async function removeCustom(userId: string, slug: string): Promise<void> {
  // By name, without decrypting: an unreadable connection is deleted too.
  const cred = await getCredential(userId, `mcp.${slug}`);
  if (cred) {
    await deleteCredential(userId, cred.id);
    await audit({ ownerId: userId, credentialId: cred.id, credentialName: cred.name, action: 'connector_disconnected', outcome: 'ok', detail: { connector: slug } });
  }
  await revokeConnection(userId, slug);
  await deleteSettings(userId, slug);
  await invalidateTools(userId, slug);
  if (await removeCustomConnector(userId, slug)) await audit({ ownerId: userId, credentialName: `mcp.${slug}`, action: 'connector_removed', outcome: 'ok', detail: { connector: slug } });
}

/** "Add connector" submitted: store it, then go straight on to connecting it. */
async function submitAdd(ctx: ActionContext, values: Record<string, Record<string, any>> | undefined, publishHome: PublishHome): Promise<void> {
  const authChoice = values?.auth?.v?.selected_option?.value;
  const prefill: AddPrefill = {
    name: val(values, 'name'),
    url: val(values, 'url'),
    description: val(values, 'description'),
    auth: authChoice === 'api_key' ? 'api_key' : 'oauth',
    header: val(values, 'header'),
  };
  const fail = async (error: string) => {
    if ((await openModal(ctx.triggerId, addModal(prefill, error))) === null) await dm(ctx.userId, `The connector wasn't added: ${error}`);
  };
  if (!(await customConnectorsAllowed())) return void (await dm(ctx.userId, 'Adding your own connectors is switched off.'));
  if (!(await hasAgreed(ctx.userId).catch(() => false))) return fail('Message me first and agree to the privacy policy, then add it.');
  const res = await addCustomConnector(ctx.userId, { name: prefill.name ?? '', url: prefill.url ?? '', description: prefill.description, auth: prefill.auth ?? 'oauth', header: prefill.header });
  if ('error' in res) return fail(res.error);
  const def = res.def;
  await audit({ ownerId: ctx.userId, credentialName: `mcp.${def.slug}`, action: 'connector_added', outcome: 'ok', detail: { connector: def.slug, host: new URL(def.url).host } });
  if (def.auth.type === 'api_key') {
    if ((await openModal(ctx.triggerId, keyModal(def))) === null) await dm(ctx.userId, `${def.name} was added. Press Connect next to it in my App Home to add your key.`);
    await publishHome(ctx.userId).catch(() => {});
    return;
  }
  if (!env.MCP_OAUTH_REDIRECT_URL) {
    await dm(ctx.userId, `${def.name} was added, but sign-in isn't set up on this bot yet, so it can't be connected.`);
    return publishHome(ctx.userId);
  }
  return connectOAuth(ctx, def, publishHome);
}

/** Block actions with the conn: prefix. */
export async function handleConnectorAction(ctx: ActionContext, publishHome: PublishHome): Promise<void> {
  if (ctx.actionId === SIGNIN) return; // a link button: Slack opens the URL
  if (ctx.actionId === ADMIN_TOGGLE) {
    if (!(await requireAdmin(ctx))) return;
    const [slug, onOff] = (ctx.value ?? '').split('|');
    if (slug) {
      await setConnectorEnabled(slug, onOff === 'on');
      log.info({ adminId: ctx.userId, slug, enabled: onOff === 'on' }, 'connector toggled');
    }
    await publishHome(ctx.userId);
    return;
  }
  if (ctx.actionId === ADMIN_CUSTOM) {
    if (!(await requireAdmin(ctx))) return;
    await setCustomConnectorsAllowed(ctx.value === 'on');
    log.info({ adminId: ctx.userId, allowed: ctx.value === 'on' }, 'custom connectors toggled');
    await publishHome(ctx.userId);
    return;
  }
  if (!connectorsConfigured()) return;
  if (ctx.actionId === ADD) {
    if (!(await customConnectorsAllowed())) return publishHome(ctx.userId);
    if ((await openModal(ctx.triggerId, addModal())) === null) await dm(ctx.userId, 'Slack took too long to open the form. Press "Add connector" again.');
    return;
  }
  if (ctx.actionId === REMOVE) {
    // Works even while "Add connector" is switched off: it only removes the user's own things.
    const slug = slugOf(ctx.value);
    if (isCustomSlug(slug)) await removeCustom(ctx.userId, slug);
    await publishHome(ctx.userId);
    return;
  }
  const def = await enabledConnector(slugOf(ctx.value), ctx.userId);
  if (!def) {
    await publishHome(ctx.userId);
    return;
  }
  if (ctx.actionId === CONNECT) {
    if (def.auth.type === 'api_key') {
      if ((await openModal(ctx.triggerId, keyModal(def))) === null) await dm(ctx.userId, 'Slack took too long to open the form. Press Connect again in a moment.');
      return;
    }
    if (!(await hasAgreed(ctx.userId).catch(() => false))) return void (await dm(ctx.userId, 'Message me first and agree to the privacy policy, then connect.'));
    return connectOAuth(ctx, def, publishHome);
  }
  if (ctx.actionId === PASTE) {
    // Open first (the trigger expires in 3 s), then nothing else to do: the submission checks everything.
    const conn = await getConnection(ctx.userId, def.slug).catch(() => null);
    if ((await openModal(ctx.triggerId, codeModal(def, pendingAuthUrl(conn)))) === null) await dm(ctx.userId, 'Slack took too long to open the form. Press "Paste code" again.');
    return;
  }
  if (ctx.actionId === DISCONNECT) {
    const conn = await getConnection(ctx.userId, def.slug).catch(() => null);
    if (conn) {
      await deleteCredential(ctx.userId, conn.cred.id);
      await audit({ ownerId: ctx.userId, credentialId: conn.cred.id, credentialName: conn.cred.name, action: 'connector_disconnected', outcome: 'ok', detail: { connector: def.slug } });
    }
    await revokeConnection(ctx.userId, def.slug);
    await publishHome(ctx.userId);
    return;
  }
  if (ctx.actionId.startsWith(KNOB)) {
    const cls = ctx.actionId.slice(KNOB.length) as ToolClass;
    const mode = (ctx.value ?? '').split('|')[1];
    if (TOOL_CLASSES.includes(cls) && isMode(mode)) await setKnob(ctx.userId, def.slug, cls, mode);
    await publishHome(ctx.userId);
    return;
  }
  if (ctx.actionId === EDIT_ACTIONS) {
    const conn = await getConnection(ctx.userId, def.slug).catch(() => null);
    if (!isConnected(conn)) return publishHome(ctx.userId);
    // Listing the server's tools can take longer than the trigger lives: open a placeholder, then fill it in.
    const viewId = await openModal(ctx.triggerId, actionsModalBase(def, [ctxBlock('Loading the actions…')], false));
    if (viewId === null) return void (await dm(ctx.userId, 'Slack took too long to open the form. Press "Edit actions" again.'));
    let view: object;
    try {
      view = await actionsModal(ctx.userId, def, conn);
    } catch (err) {
      view = actionsModalBase(def, [ctxBlock(`:warning: Couldn't load the actions: ${mrkdwnEscape(err instanceof ConnectorError ? err.message : errMsg(err))}`)], false);
    }
    if (viewId) await slackCall('views.update', { view_id: viewId, view }).catch((err) => log.warn({ err }, 'connector actions modal update failed'));
  }
}

function val(values: Record<string, Record<string, any>> | undefined, block: string): string {
  const v = values?.[block]?.v?.value;
  return typeof v === 'string' ? v.trim() : '';
}

/** view_submission for the connm: modals. */
export async function handleConnectorModal(ctx: ActionContext, publishHome: PublishHome): Promise<void> {
  if (ctx.body?.type !== 'view_submission' || !connectorsConfigured()) return;
  if (ctx.actionId === ADD_MODAL) return submitAdd(ctx, openViewState(ctx.body).values, publishHome);
  let slug = '';
  try {
    slug = String(JSON.parse(ctx.value ?? '{}').slug ?? '');
  } catch {
    return;
  }
  const def = await enabledConnector(slug, ctx.userId);
  if (!def) return void (await dm(ctx.userId, 'That connector is no longer available.'));
  const values = openViewState(ctx.body).values;
  const cb = ctx.actionId;

  if (cb === KEY_MODAL) {
    const fail = async (error: string) => {
      if ((await openModal(ctx.triggerId, keyModal(def, error))) === null) await dm(ctx.userId, `${def.name} wasn't connected: ${error}`);
    };
    if (def.auth.type !== 'api_key') return;
    if (!(await hasAgreed(ctx.userId).catch(() => false))) return fail('Message me first and agree to the privacy policy, then connect.');
    const key = val(values, 'key');
    if (!key) return fail('The key is empty.');
    // Check the key works before storing it.
    try {
      const probe: Connection = { cred: { id: '', ownerId: ctx.userId, name: `mcp.${def.slug}`, kind: 'connector', service: def.name, meta: {}, createdAt: new Date(), updatedAt: new Date(), lastUsedAt: null }, secret: { type: 'api_key', apiKey: key } };
      await listServerTools(def, probe);
    } catch (err) {
      const msg = err instanceof ConnectorError ? err.message : errMsg(err).replaceAll(key, '[key]');
      return fail(`${def.name} didn't accept it: ${truncate(msg, 300)}`);
    }
    try {
      const had = await getConnection(ctx.userId, def.slug).catch(() => null);
      const conn = await saveApiKeyConnection(ctx.userId, def, key);
      await revokeConnection(ctx.userId, def.slug);
      await audit({ ownerId: ctx.userId, credentialId: conn.cred.id, credentialName: conn.cred.name, action: had ? 'connector_replaced' : 'connector_connected', outcome: 'ok', detail: { connector: def.slug } });
    } catch (err) {
      return fail(err instanceof VaultError ? err.message : 'Something went wrong saving it. Try again.');
    }
    await publishHome(ctx.userId).catch(() => {});
    return;
  }

  if (cb === CODE_MODAL) {
    const conn0 = await getConnection(ctx.userId, def.slug).catch(() => null);
    const fail = async (error: string) => {
      if ((await openModal(ctx.triggerId, codeModal(def, pendingAuthUrl(conn0), error))) === null) await dm(ctx.userId, `${def.name} wasn't connected: ${error}`);
    };
    const blob = parseOAuthBlob(val(values, 'code'));
    if (!blob) return fail("That doesn't look like the code from the sign-in page. Copy the whole code.");
    try {
      await finishOAuth(ctx.userId, def, blob);
    } catch (err) {
      log.warn({ err: err instanceof ConnectorError ? err.message : err, slug: def.slug }, 'connector OAuth finish failed');
      return fail(err instanceof ConnectorError ? err.message : `The server refused it: ${truncate(errMsg(err), 200)}`);
    }
    await revokeConnection(ctx.userId, def.slug);
    const conn = await getConnection(ctx.userId, def.slug).catch(() => null);
    await audit({ ownerId: ctx.userId, credentialId: conn?.cred.id, credentialName: `mcp.${def.slug}`, action: 'connector_connected', outcome: 'ok', detail: { connector: def.slug } });
    if (conn) await connectorTools(ctx.userId, def, conn).catch(() => null); // warm the cache
    await dm(ctx.userId, `${def.name} is connected. Its settings are in my App Home.`);
    await publishHome(ctx.userId).catch(() => {});
    return;
  }

  if (cb === ACTIONS_MODAL) {
    const overrides: Record<string, Mode> = {};
    for (const [blockId, v] of Object.entries(values ?? {})) {
      if (!blockId.startsWith('t:')) continue;
      const choice = v?.v?.selected_option?.value;
      if (isMode(choice)) overrides[blockId.slice(2)] = choice;
    }
    await setOverrides(ctx.userId, def.slug, overrides);
    await publishHome(ctx.userId).catch(() => {});
  }
}

