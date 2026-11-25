/**
 * Vault, sandbox side (issue #36; docs/sandbox.md §3.9). Only when the vault is configured; every credential belongs
 * to the subagent's owner (ctx.speakerId, vaultIdentity) and every use waits for the owner's approval card, because
 * anyone in the thread can steer a subagent (message_subagent). Secrets go into the sandbox over stdin, never argv,
 * env or the model, and are registered for output scrubbing (registerScrub) before they get there.
 * - browser_fill_credential: type a stored login's username / password / current TOTP code into a field, only on a
 *   page whose host the login is tied to (re-checked in the sandbox right before typing).
 * - sandbox_use_credential: a stored secret as files in /work/.vault, for commands (removed at run end and before a
 *   pause snapshot).
 * - sandbox_save_credential: store a secret the agent produced in the sandbox (from files) without reading it.
 * - browser_save_session / browser_load_session: a logged-in browser state (cookies + localStorage) saved to the
 *   owner's vault and loaded into a later subagent's browser.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { parseThreadId, threadTsArg } from '../../core/events.js';
import { slackCall } from '../../core/slack.js';
import type { ToolContext } from '../../core/tools.js';
import { takeLimit } from '../../features/guard.js';
import { mrkdwnEscape, truncate } from '../../features/util.js';
import { requestApproval, waitForApproval } from '../../features/vault/approvals.js';
import { audit } from '../../features/vault/audit.js';
import { vaultConfigured } from '../../features/vault/crypto.js';
import { vaultIdentity } from '../../features/vault/identity.js';
import { registerScrub } from '../../features/vault/scrub.js';
import {
  describeCredential,
  getCredential,
  hostAllowed,
  listCredentials,
  normalizeName,
  parseDomains,
  revealSecret,
  saveCredential,
  touchCredential,
  validName,
  VaultError,
  type Credential,
} from '../../features/vault/store.js';
import { totpCode, validTotp } from '../../features/vault/totp.js';
import { limits } from '../../config.js';
import { log } from '../../log.js';
import { errMsg } from '../../tools/util.js';
import { shq, workPath, type Handle } from '../provider.js';
import { badPath, inVaultDir, p, reg, run } from '../tools.js';
import { ab, normRef, pageScript, parseSections, shortError, STDIN_VALUE } from './cli.js';
import { abExec, browserRefusal, leavePage, leftText, logAction, pageCall, verdictOf } from './page.js';
import { originOf } from './policy.js';
import { filterState, parseState, stateCounts, stateDomains } from './state.js';
import { markVaultFiles, VAULT_DIR } from './vault-files.js';

const SECRET_FILE_MAX = 16 * 1024;

/** Tell the owner privately (ephemeral in the thread, else a DM). */
async function noticeOwner(ctx: ToolContext, ownerId: string, text: string): Promise<void> {
  const { channelId, threadTs } = parseThreadId(ctx.threadId);
  await slackCall('chat.postEphemeral', { channel: channelId, user: ownerId, ...threadTsArg(threadTs), text }).catch(() =>
    slackCall('chat.postMessage', { channel: ownerId, text }).catch((err) => log.warn({ err }, 'vault notice failed')),
  );
}

/** Ask the owner (wait mode) and wait for the answer. Null = go ahead; else the model-facing refusal. */
async function approve(ctx: ToolContext, o: { ownerId: string; kind: string; c?: Credential; name: string; tool: string; grantKey: string | null; title: string; detail: string[] }): Promise<string | null> {
  const res = await requestApproval({
    ownerId: o.ownerId,
    threadId: ctx.threadId,
    kind: o.kind,
    mode: 'wait',
    credentialId: o.c?.id ?? null,
    credentialName: o.name,
    tool: o.tool,
    grantKey: o.grantKey,
    title: o.title,
    detail: o.detail,
  });
  if (res.status === 'failed') return `Couldn't ask the owner: ${res.reason}.`;
  if (res.status === 'granted') return null;
  const r = await waitForApproval(res.id, ctx.abortSignal);
  if (r === 'approved') return null;
  if (r === 'denied') return 'The owner denied it. Nothing was used; carry on without it or explain in your result.';
  if (r === 'aborted') return 'Stopped.';
  return "The owner didn't answer in time; nothing was used.";
}

const purposeField = z.string().min(1).max(300).describe("What it's for, in a sentence; shown to the owner on the approval card");
const why = (purpose: string) => `*Why (the agent's words):* ${truncate(mrkdwnEscape(purpose), 400)}`;

async function noneOf(ownerId: string, kinds: Credential['kind'][], label: string): Promise<string> {
  const list = await listCredentials(ownerId, kinds);
  return list.length ? `Their ${label}: ${list.map((c) => describeCredential(c)).join('; ')}.` : `They have no ${label} stored (request_credential asks them to add one).`;
}

export function registerSandboxVaultTools(): void {
  if (!vaultConfigured()) return;

  // ---------- browser_fill_credential ----------

  reg('browser_fill_credential', (ctx) =>
    tool({
      description:
        "Type part of a login from the vault of the person you're working for into a field of the current page: its username, its password, or the current one-time code (TOTP). Only on a site the login is tied to; the owner approves each use on a private card (or for 10 minutes in this thread). You never see the password. Get the field's ref from a snapshot first; then click the login button yourself.",
      inputSchema: z.object({
        ref: z.string().min(1).max(20).describe('The field, e.g. "@e4"'),
        credential: z.string().min(1).max(40).describe('Login name (list_credentials)'),
        field: z.enum(['username', 'password', 'totp']),
        purpose: purposeField.optional(),
      }),
      execute: async ({ ref, credential, field, purpose }) => {
        const id = vaultIdentity(ctx);
        if (!id.ok) return id.reason;
        const r = normRef(ref);
        if (!r) return `"${ref.slice(0, 40)}" isn't an element ref (use one like @e4 from the latest snapshot).`;
        const refusal = await browserRefusal(ctx);
        if (refusal) return refusal;
        const c = await getCredential(id.ownerId, credential);
        if (!c || c.kind !== 'login') return `No login called "${normalizeName(credential)}". ${await noneOf(id.ownerId, ['login'], 'logins')}`;
        if (!c.meta.domains?.length) return `"${c.name}" isn't tied to a website, so it can't be typed into a page. The owner can add its website in App Home.`;
        if (field === 'totp' && !c.meta.totp) return `"${c.name}" has no one-time code (TOTP) set up; ask the owner for the code instead.`;
        // Where is the browser now? (Approval is asked outside the sandbox call: it can take minutes.)
        const found: { page?: { url: string; host: string; origin: string; title?: string } } = {};
        const looked = await run(ctx, 'browser_fill_credential', async (h) => {
          const res = await abExec(ctx, h, pageScript({}));
          const s = parseSections(res.stdout.toString('utf8'));
          const v = verdictOf(s);
          if (v && !v.ok) {
            await leavePage(ctx, h);
            return leftText(v);
          }
          const origin = s.url ? originOf(s.url) : null;
          if (!s.url || !v?.ok || !v.host || !origin) return 'No web page is open: browser_open the login page first.';
          found.page = { url: s.url, host: v.host, origin, ...(s.title ? { title: s.title } : {}) };
          return '';
        });
        const where = found.page;
        if (!where) return looked;
        if (!where.url.startsWith('https://')) {
          await audit({ ownerId: id.ownerId, credentialId: c.id, credentialName: c.name, action: 'browser_fill', tool: 'browser_fill_credential', threadId: ctx.threadId, outcome: 'refused', detail: { host: where.host, reason: 'not https' } });
          return 'Logins are only typed into https pages.';
        }
        if (!hostAllowed(where.host, c.meta.domains)) {
          await audit({ ownerId: id.ownerId, credentialId: c.id, credentialName: c.name, action: 'browser_fill', tool: 'browser_fill_credential', threadId: ctx.threadId, outcome: 'refused', detail: { host: where.host } });
          return `"${c.name}" may only be typed into ${c.meta.domains.join(', ')}; the browser is on ${where.host}.`;
        }
        const limited = await takeLimit('credential_use', id.ownerId, ctx.threadId);
        if (limited) return limited;
        const fieldLabel = field === 'totp' ? 'current one-time code' : field;
        const path = (() => {
          try {
            return new URL(where.url).pathname;
          } catch {
            return '/';
          }
        })();
        const denied = await approve(ctx, {
          ownerId: id.ownerId,
          kind: 'browser_fill',
          c,
          name: c.name,
          tool: 'browser_fill_credential',
          grantKey: `cred:${c.id}`,
          title: `*Type the ${fieldLabel} of your login \`${mrkdwnEscape(c.name)}\` into ${mrkdwnEscape(where.host)}?*`,
          detail: [
            `*Page:* \`${truncate(mrkdwnEscape(where.origin + path), 300)}\`${where.title ? ` (“${truncate(mrkdwnEscape(where.title), 120)}”)` : ''}`,
            `*Field:* the page's element ${r}, ${fieldLabel}`,
            ...(purpose ? [why(purpose)] : []),
            'It is typed by code inside the agent’s browser; the agent never sees it.',
          ],
        });
        if (denied) return denied;
        // Register for scrubbing before the secret reaches the sandbox.
        await registerScrub(ctx.subagentId!, id.ownerId, c.id);
        let value: string;
        try {
          const s = await revealSecret({ ...c, kind: 'login' });
          if (field === 'username') value = s.username;
          else if (field === 'password') value = s.password;
          else {
            if (!s.totp) return `"${c.name}" has no TOTP seed.`;
            let t = totpCode(s.totp);
            if (t.secondsLeft < 4) {
              await new Promise((res) => setTimeout(res, (t.secondsLeft + 1) * 1000));
              t = totpCode(s.totp);
            }
            value = t.code;
          }
        } catch (err) {
          return err instanceof VaultError ? err.message : `Couldn't open the credential: ${errMsg(err)}`;
        }
        const done = { ok: false };
        const text = await run(ctx, 'browser_fill_credential', async (h) => {
          const out = await pageCall(ctx, h, {
            action: 'fill_credential',
            ref: r,
            logExtra: { credential: c.name, field },
            // Same page as approved (origin), and a password goes only into a password field. The value comes on stdin.
            script: {
              guard: [
                // The value first (nothing else may read stdin), then the checks with stdin closed.
                'IFS= read -r -d "" SBX_VALUE || true',
                `case "$(timeout 15 agent-browser get url </dev/null 2>/dev/null | tail -n 1)" in "$SBX_ORIGIN"|"$SBX_ORIGIN"/*) ;; *) echo ORIGIN_CHANGED; exit 3;; esac`,
                ...(field === 'password' ? [`t=$(timeout 10 agent-browser get attr ${shq(r)} type </dev/null 2>/dev/null | tail -n 1 | tr -d '[:space:]"'); if [ "$t" != password ]; then echo NOT_PASSWORD_FIELD; exit 3; fi`] : []),
              ].join('\n'),
              actions: [['fill', r, '--', STDIN_VALUE]],
              snapshot: 'interactive',
            },
            stdin: Buffer.from(`${value}\0`),
            env: { SBX_ORIGIN: where.origin },
            guards: {
              ORIGIN_CHANGED: `The page changed since the owner approved (it is no longer on ${where.origin}); nothing was typed. Open the login page again and retry.`,
              NOT_PASSWORD_FIELD: `${r} isn't a password field; nothing was typed. Snapshot again and pick the password field.`,
            },
            ok: `Typed the ${fieldLabel} of "${c.name}" into ${r} (hidden from you). Now continue the login (e.g. click the sign-in button).`,
            failed: `Typing into ${r} failed`,
          });
          done.ok = out.startsWith('Typed the');
          return out;
        });
        const okDone = done.ok;
        await audit({ ownerId: id.ownerId, credentialId: c.id, credentialName: c.name, action: 'browser_fill', tool: 'browser_fill_credential', threadId: ctx.threadId, outcome: okDone ? 'ok' : 'error', detail: { host: where.host, path: path.slice(0, 200), field } });
        if (okDone) await touchCredential(c.id);
        return text;
      },
    }),
  );

  // ---------- sandbox_use_credential ----------

  reg('sandbox_use_credential', (ctx) =>
    tool({
      description: `Put a credential from the vault of the person you're working for into your sandbox as files, for commands (e.g. an API key for a script, a token for git): an API key → ${VAULT_DIR}/<name>; a login → ${VAULT_DIR}/<name>.username, .password and .totp (the current one-time code). Reference them in commands, e.g. "$(cat ${VAULT_DIR}/github)"; never print, cat, log or export them. The owner approves each use; the files are deleted when this run ends. For a website login in the browser use browser_fill_credential instead.`,
      inputSchema: z.object({ credential: z.string().min(1).max(40), purpose: purposeField }),
      execute: async ({ credential, purpose }) => {
        const id = vaultIdentity(ctx);
        if (!id.ok) return id.reason;
        const c = await getCredential(id.ownerId, credential);
        if (!c || (c.kind !== 'token' && c.kind !== 'login')) return `No API key or login called "${normalizeName(credential)}". ${await noneOf(id.ownerId, ['token', 'login'], 'credentials')}`;
        const limited = await takeLimit('credential_use', id.ownerId, ctx.threadId);
        if (limited) return limited;
        const files = c.kind === 'token' ? [`${VAULT_DIR}/${c.name}`] : [`${VAULT_DIR}/${c.name}.username`, `${VAULT_DIR}/${c.name}.password`, ...(c.meta.totp ? [`${VAULT_DIR}/${c.name}.totp`] : [])];
        const denied = await approve(ctx, {
          ownerId: id.ownerId,
          kind: 'sandbox_file',
          c,
          name: c.name,
          tool: 'sandbox_use_credential',
          // Its own grant: a file in the sandbox isn't pinned to the credential's websites like a request or a fill is.
          grantKey: `cred:${c.id}:sandbox`,
          title: `*Give the agent's code sandbox your credential \`${mrkdwnEscape(c.name)}\`?*`,
          detail: [
            `*As:* ${files.map((f) => `\`${f}\``).join(', ')}, for commands the agent runs there.`,
            why(purpose),
            "Code in the sandbox can read it and could send it anywhere, so only allow this for a task you trust. It's deleted when this run ends; the agent is told never to print it.",
          ],
        });
        if (denied) return denied;
        await registerScrub(ctx.subagentId!, id.ownerId, c.id);
        await markVaultFiles(ctx.subagentId!);
        let contents: Buffer[];
        try {
          if (c.kind === 'token') contents = [Buffer.from((await revealSecret({ ...c, kind: 'token' })).value)];
          else {
            const s = await revealSecret({ ...c, kind: 'login' });
            contents = [Buffer.from(s.username), Buffer.from(s.password), ...(c.meta.totp && s.totp ? [Buffer.from(totpCode(s.totp).code)] : [])];
          }
        } catch (err) {
          return err instanceof VaultError ? err.message : `Couldn't open the credential: ${errMsg(err)}`;
        }
        const done = { ok: false };
        const text = await run(ctx, 'sandbox_use_credential', async (h) => {
          for (let i = 0; i < files.length; i++) await writeSecretFile(h, files[i]!, contents[i] ?? Buffer.alloc(0));
          done.ok = true;
          return `Ready: ${files.join(', ')} (readable only by you). Use them in commands like "$(cat ${files[c.kind === 'token' ? 0 : 1]})"; never print or export them. They're deleted when this run ends.${c.kind === 'login' && c.meta.totp ? ' The .totp code is valid for about 30 s.' : ''}`;
        });
        await audit({ ownerId: id.ownerId, credentialId: c.id, credentialName: c.name, action: 'sandbox_file', tool: 'sandbox_use_credential', threadId: ctx.threadId, outcome: done.ok ? 'ok' : 'error', detail: { files: files.length } });
        if (done.ok) await touchCredential(c.id);
        return text;
      },
    }),
  );

  // ---------- sandbox_save_credential ----------

  reg('sandbox_save_credential', (ctx) =>
    tool({
      description:
        "Save a secret you produced in your sandbox (e.g. an API key you created for the person you're working for, written to a file) to their vault, straight from the file(s), so it never passes through you. The file(s) are deleted afterwards and the owner is told. Never overwrites: pick a new name. Tie it to the website(s) it's for.",
      inputSchema: z.object({
        name: z.string().min(1).max(40).describe('Short name, e.g. "openai-key"'),
        type: z.enum(['api_key', 'login']),
        website: z.string().max(300).optional().describe('Domain(s) it is for, comma-separated, e.g. "api.openai.com"'),
        file: z.string().optional().describe('api_key: the file holding the key, e.g. "/work/out/key.txt"'),
        username_file: z.string().optional().describe('login: file with the username'),
        password_file: z.string().optional().describe('login: file with the password'),
        totp_file: z.string().optional().describe('login: file with a TOTP seed (base32 or otpauth:// URI), if any'),
        note: z.string().max(300).optional(),
      }),
      execute: async (a) => {
        const id = vaultIdentity(ctx);
        if (!id.ok) return id.reason;
        const name = normalizeName(a.name);
        if (!validName(name)) return 'Invalid name: use lowercase letters, digits, "-", "_" or "." (up to 40 characters).';
        if (await getCredential(id.ownerId, name)) return `A credential called "${name}" already exists. Pick another name (only the owner can replace one, in App Home).`;
        const domains = parseDomains(a.website);
        if (a.website && domains.length === 0) return 'website must be domain names, e.g. "github.com".';
        const wanted = a.type === 'api_key' ? { value: a.file } : { username: a.username_file, password: a.password_file, ...(a.totp_file ? { totp: a.totp_file } : {}) };
        if (a.type === 'api_key' && !a.file) return 'api_key needs file.';
        if (a.type === 'login' && (!a.username_file || !a.password_file)) return 'login needs username_file and password_file.';
        const paths: Record<string, string> = {};
        for (const [k, raw] of Object.entries(wanted)) {
          const abs = workPath(raw!);
          if (!abs) return badPath(raw!);
          if (inVaultDir(abs)) return `${abs} is a copy of a credential that's already in the vault.`;
          paths[k] = abs;
        }
        const result: { saved?: Credential } = {};
        const text = await run(ctx, 'sandbox_save_credential', async (h) => {
          const vals: Record<string, string> = {};
          for (const [k, abs] of Object.entries(paths)) {
            const { bytes, size } = await p().readFile(h, abs, { maxBytes: SECRET_FILE_MAX });
            if (size > SECRET_FILE_MAX) return `${abs} is too large for a secret (over ${SECRET_FILE_MAX / 1024} KB).`;
            const v = bytes.toString('utf8').replace(/\r?\n$/, '');
            if (!v.trim()) return `${abs} is empty.`;
            vals[k] = v;
          }
          if (vals.totp && !validTotp(vals.totp)) return "The TOTP file isn't a valid TOTP seed (base32) or otpauth:// URI.";
          let saved: Credential;
          try {
            saved =
              a.type === 'api_key'
                ? await saveCredential({ ownerId: id.ownerId, name, kind: 'token', meta: { domains, savedBy: 'agent', ...(a.note ? { note: a.note } : {}) }, secret: { value: vals.value! } })
                : await saveCredential({
                    ownerId: id.ownerId,
                    name,
                    kind: 'login',
                    meta: { domains, savedBy: 'agent', totp: Boolean(vals.totp), ...(a.note ? { note: a.note } : {}) },
                    secret: { username: vals.username!, password: vals.password!, ...(vals.totp ? { totp: vals.totp } : {}) },
                  });
          } catch (err) {
            return err instanceof VaultError ? err.message : `Couldn't save it: ${errMsg(err)}`;
          }
          result.saved = saved;
          await registerScrub(ctx.subagentId!, id.ownerId, saved.id);
          await p()
            .exec(h, ['bash', '-c', `rm -f -- ${Object.values(paths).map(shq).join(' ')}`], { timeoutMs: 20_000, maxOutputBytes: 1024 })
            .catch((err) => log.warn({ err }, 'deleting saved secret files failed'));
          return `Saved "${name}" (${describeCredential(saved)}) and deleted ${Object.values(paths).join(', ')}. Don't repeat the secret anywhere.`;
        });
        if (result.saved) {
          const c = result.saved;
          await audit({ ownerId: id.ownerId, credentialId: c.id, credentialName: name, action: 'created', tool: 'sandbox_save_credential', threadId: ctx.threadId, outcome: 'ok', detail: { by: 'agent', from: 'sandbox' } });
          await noticeOwner(ctx, id.ownerId, `:lock: I saved \`${name}\` to your vault (from my sandbox). You can see or delete it in my App Home.`);
        }
        return text;
      },
    }),
  );

  // ---------- browser_save_session ----------

  reg('browser_save_session', (ctx) =>
    tool({
      description:
        "Save your browser's logged-in state (cookies + local storage) for a website to the vault of the person you're working for, so later subagents of theirs can continue logged in (browser_load_session). Only after they logged in (or you did with browser_fill_credential) for a task that needs it again. The owner approves; you never see the cookies.",
      inputSchema: z.object({
        name: z.string().min(1).max(40).describe('Short name, e.g. "github-session"'),
        website: z.string().max(300).optional().describe('Domain(s) to keep, e.g. "github.com"; default: every site the browser has cookies for (keep it to the one you need)'),
        purpose: purposeField,
      }),
      execute: async ({ name: rawName, website, purpose }) => {
        const id = vaultIdentity(ctx);
        if (!id.ok) return id.reason;
        const name = normalizeName(rawName);
        if (!validName(name)) return 'Invalid name: use lowercase letters, digits, "-", "_" or "." (up to 40 characters).';
        if (await getCredential(id.ownerId, name)) return `A credential called "${name}" already exists. Pick another name.`;
        const wanted = parseDomains(website);
        if (website && !wanted.length) return 'website must be domain names, e.g. "github.com".';
        const refusal = await browserRefusal(ctx);
        if (refusal) return refusal;
        const got: { raw?: string } = {};
        const exported = await run(ctx, 'browser_save_session', async (h) => {
          const res = await abExec(ctx, h, `f=$(mktemp); ${ab('state', 'save')} "$f" >/dev/null 2>&1 || { echo STATE_SAVE_FAILED; rm -f "$f"; exit 3; }; cat "$f"; rm -f "$f"`, { maxBytes: limits.vaultMaxSecretBytes + 1024, timeoutS: 60 });
          const out = res.stdout.toString('utf8');
          if (out.startsWith('STATE_SAVE_FAILED') || res.exitCode !== 0) return 'Saving the browser state failed (is the browser open? browser_open the site first).';
          if (res.stdoutTruncated) return `The browser state is too large to store (over ${Math.round(limits.vaultMaxSecretBytes / 1024)} KB). Pass website to keep only that site.`;
          got.raw = out;
          return '';
        });
        if (got.raw == null) return exported;
        const state = parseState(got.raw);
        if (!state) return "The browser's state file wasn't readable; nothing was saved.";
        const domains = wanted.length ? wanted : stateDomains(state);
        if (!domains.length) return 'The browser has no cookies or site data to save. Log in first.';
        const kept = wanted.length ? filterState(state, wanted) : state;
        const n = stateCounts(kept);
        if (!n.cookies && !n.origins) return `The browser has no cookies or site data for ${wanted.join(', ')}. Log in there first.`;
        const json = JSON.stringify(kept);
        if (Buffer.byteLength(json) > limits.vaultMaxSecretBytes) return `That state is too large to store (over ${Math.round(limits.vaultMaxSecretBytes / 1024)} KB); pass website to keep only one site.`;
        const denied = await approve(ctx, {
          ownerId: id.ownerId,
          kind: 'browser_session_save',
          name,
          tool: 'browser_save_session',
          grantKey: null,
          title: `*Save the agent's browser login for ${mrkdwnEscape(domains.slice(0, 5).join(', '))}${domains.length > 5 ? ` and ${domains.length - 5} more` : ''} to your vault as \`${mrkdwnEscape(name)}\`?*`,
          detail: [
            `*What:* ${n.cookies} cookie${n.cookies === 1 ? '' : 's'}${n.origins ? ` and site storage for ${n.origins} site${n.origins === 1 ? '' : 's'}` : ''}. Whoever has them is logged in as that account on those sites.`,
            why(purpose),
            'Stored encrypted; only your own subagents can load it, and each load asks you first. Delete it any time in my App Home.',
          ],
        });
        if (denied) return denied;
        try {
          const c = await saveCredential({ ownerId: id.ownerId, name, kind: 'browser_session', meta: { domains, savedBy: 'agent' }, secret: { state: json } });
          await audit({ ownerId: id.ownerId, credentialId: c.id, credentialName: name, action: 'created', tool: 'browser_save_session', threadId: ctx.threadId, outcome: 'ok', detail: { domains: domains.slice(0, 10), cookies: n.cookies, origins: n.origins } });
          logAction(ctx, 'save_session', null, { credential: name });
          return `Saved the browser login for ${domains.join(', ')} as "${name}". A later subagent can load it with browser_load_session (the owner approves).`;
        } catch (err) {
          return err instanceof VaultError ? err.message : `Couldn't save it: ${errMsg(err)}`;
        }
      },
    }),
  );

  // ---------- browser_load_session ----------

  reg('browser_load_session', (ctx) =>
    tool({
      description:
        "Load a saved browser login (browser_save_session) of the person you're working for into your browser, so you're logged in to that site. The owner approves. Then browser_open the page you need.",
      inputSchema: z.object({ name: z.string().min(1).max(40), purpose: purposeField }),
      execute: async ({ name, purpose }) => {
        const id = vaultIdentity(ctx);
        if (!id.ok) return id.reason;
        const refusal = await browserRefusal(ctx);
        if (refusal) return refusal;
        const c = await getCredential(id.ownerId, name);
        if (!c || c.kind !== 'browser_session') return `No saved browser login called "${normalizeName(name)}". ${await noneOf(id.ownerId, ['browser_session'], 'saved browser logins')}`;
        const limited = await takeLimit('credential_use', id.ownerId, ctx.threadId);
        if (limited) return limited;
        const sites = c.meta.domains?.join(', ') || 'unknown sites';
        const denied = await approve(ctx, {
          ownerId: id.ownerId,
          kind: 'browser_session_load',
          c,
          name: c.name,
          tool: 'browser_load_session',
          grantKey: `cred:${c.id}`,
          title: `*Log the agent's browser in with your saved login \`${mrkdwnEscape(c.name)}\` (${mrkdwnEscape(sites)})?*`,
          detail: [why(purpose), `The agent's browser will be logged in as you on ${mrkdwnEscape(sites)} for this task. Its sandbox is deleted 24 h after the task goes idle.`],
        });
        if (denied) return denied;
        let state: string;
        try {
          state = (await revealSecret({ ...c, kind: 'browser_session' })).state;
        } catch (err) {
          return err instanceof VaultError ? err.message : `Couldn't open it: ${errMsg(err)}`;
        }
        const done = { ok: false };
        const text = await run(ctx, 'browser_load_session', async (h) => {
          const res = await abExec(ctx, h, `f=$(mktemp); cat > "$f"; ${ab('state', 'load')} "$f" 2>&1; rc=$?; rm -f "$f"; exit $rc`, { stdin: Buffer.from(state), timeoutS: 60, maxBytes: 64 * 1024 });
          if (res.exitCode !== 0) return `Loading it failed: ${shortError(res.stdout.toString('utf8') + res.stderr.toString('utf8'), 300)}`;
          done.ok = true;
          return `Loaded the saved login "${c.name}" (${sites}). browser_open the page you need now.`;
        });
        const ok = done.ok;
        await audit({ ownerId: id.ownerId, credentialId: c.id, credentialName: c.name, action: 'browser_session_load', tool: 'browser_load_session', threadId: ctx.threadId, outcome: ok ? 'ok' : 'error', detail: { domains: c.meta.domains?.slice(0, 10) ?? [] } });
        if (ok) {
          await touchCredential(c.id);
          logAction(ctx, 'load_session', null, { credential: c.name });
        }
        return text;
      },
    }),
  );
}

/** A secret file in /work/.vault: the directory 700, the file 600, owned by the sandbox user, content over stdin. */
async function writeSecretFile(h: Handle, path: string, content: Buffer): Promise<void> {
  const r = await p().exec(h, ['bash', '-c', `umask 077 && mkdir -p ${shq(VAULT_DIR)} && chmod 700 ${shq(VAULT_DIR)} && cat > ${shq(path)}`], { stdin: content, timeoutMs: 30_000, maxOutputBytes: 4096 });
  if (r.exitCode !== 0) throw new Error(`writing ${path} failed: ${r.stderr.toString('utf8').trim().slice(0, 200) || `exit ${r.exitCode}`}`);
}
