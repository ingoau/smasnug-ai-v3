/**
 * Privacy policy consent. The policy is `PRIVACY.md` at the repo root (`PRIVACY_POLICY_PATH` overrides); its
 * version is a hash of the text.
 *
 * A user who has never agreed (to any version) can't start a turn: the pipeline holds their message and shows an
 * ephemeral prompt (src/pipeline/consent.ts). The policy says it can change at any time: someone who agreed to an
 * earlier version isn't asked again, but gets a one-off ephemeral notice on their first request after the change
 * (claimNotice), which records the current version for them (`via = 'notice'`). App Home's "Withdraw consent & delete
 * my data" (src/pipeline/consent.ts handlePrivacyWithdraw) removes their consent and stored data. Reading them is fine: their messages are still stored and give context
 * for others' turns. "Read the privacy policy" opens it in a modal (no file upload: bots can't re-share a file by id,
 * and ephemerals carry no files).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { env } from '../config.js';
import type { ActionContext } from '../core/actions.js';
import { slackCall } from '../core/slack.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { privacyPolicyPath } from './privacy-path.js';
import { respond } from './util.js';

export const PRIVACY_READ_ACTION = 'privacy:read';
export const PRIVACY_AGREE_ACTION = 'privacy:agree';
export const PRIVACY_WITHDRAW_ACTION = 'privacy:withdraw';

/** Swappable for tests (vitest turns consent off, see src/testing/test-db.ts). */
export const privacySettings = { required: env.PRIVACY_CONSENT === 'on' };

let cached: { text: string; version: string } | undefined;

/** The policy text and its version (sha256 prefix of the text). Read once per process. */
export function privacyPolicy(): { text: string; version: string } {
  if (!cached) {
    const text = readFileSync(privacyPolicyPath(), 'utf8');
    cached = { text, version: createHash('sha256').update(text).digest('hex').slice(0, 16) };
  }
  return cached;
}

/**
 * Users known to have agreed to some version, until when (ms). Short-lived: a withdrawal on another worker only
 * clears that worker's cache, so this one may still say yes for up to AGREED_TTL_MS.
 */
const agreed = new Map<string, number>();
const AGREED_TTL_MS = 30_000;
/** Users known to have the current version on record (agreed to it, or been told about it). */
const current = new Set<string>();

/** Has the user agreed to the policy (any version)? Only a yes is cached, so a "no" always comes from the DB. */
export async function hasAgreed(userId: string): Promise<boolean> {
  if (!privacySettings.required || (agreed.get(userId) ?? 0) > Date.now()) return true;
  const [row] = await sql`select 1 from privacy_consent where user_id = ${userId} limit 1`;
  if (row) agreed.set(userId, Date.now() + AGREED_TTL_MS);
  return Boolean(row);
}

/** Record agreement to the current version. Returns true the first time. */
export async function recordAgreement(userId: string): Promise<boolean> {
  const rows = await sql`insert into privacy_consent (user_id, policy_version) values (${userId}, ${privacyPolicy().version})
                         on conflict do nothing returning user_id`;
  agreed.set(userId, Date.now() + AGREED_TTL_MS);
  current.add(userId);
  return rows.length > 0;
}

/**
 * For a user who has agreed to some version: true exactly once (across workers) when the current version isn't on
 * record for them yet, recording it as seen via the update notice. The caller then shows the notice.
 */
export async function claimNotice(userId: string): Promise<boolean> {
  if (!privacySettings.required || current.has(userId)) return false;
  const rows = await sql`insert into privacy_consent (user_id, policy_version, via) values (${userId}, ${privacyPolicy().version}, 'notice')
                         on conflict do nothing returning user_id`;
  current.add(userId);
  return rows.length > 0;
}

/** Withdraw consent: every version's record, so the next request asks them to agree again. */
export async function forgetConsent(userId: string): Promise<void> {
  await sql`delete from privacy_consent where user_id = ${userId}`;
  agreed.delete(userId);
  current.delete(userId);
}

/** The App Home button. Confirm text is plain_text, at most 300 characters. */
export function withdrawButton(agreedNow: boolean) {
  return {
    type: 'button',
    action_id: PRIVACY_WITHDRAW_ACTION,
    text: { type: 'plain_text', text: agreedNow ? 'Withdraw consent & delete my data' : 'Delete my data' },
    value: 'withdraw',
    style: 'danger',
    confirm: {
      title: { type: 'plain_text', text: agreedNow ? 'Withdraw and delete?' : 'Delete your data?' },
      text: {
        type: 'plain_text',
        text:
          (agreedNow ? "I'll stop answering you until you agree again, and permanently delete " : 'This permanently deletes ') +
          "what I remember about you, your messages and files I've stored, and records of my answers in those conversations. " +
          'Copies elsewhere are deleted within 30 days.',
      },
      confirm: { type: 'plain_text', text: agreedNow ? 'Withdraw & delete' : 'Delete' },
      deny: { type: 'plain_text', text: 'Cancel' },
      style: 'danger',
    },
  };
}

/** For tests. */
export function resetPrivacyCache() {
  agreed.clear();
  current.clear();
  cached = undefined;
}

export const PROMPT_TEXT = `Before I can help, please read and agree to ${env.BOT_DISPLAY_NAME}'s privacy policy.`;

export const UPDATED_TEXT = `${env.BOT_DISPLAY_NAME}'s privacy policy has been updated.`;

/** The one-off notice for someone who agreed to an earlier version. */
export function updatedBlocks(): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:information_source: *${env.BOT_DISPLAY_NAME}'s privacy policy has been updated.* Using me from now on means you accept the new version. You can withdraw and delete your data any time in my *App Home*.`,
      },
      accessory: { type: 'button', action_id: PRIVACY_READ_ACTION, text: { type: 'plain_text', text: 'Read the privacy policy' }, value: 'read' },
    },
  ];
}

export function promptBlocks(): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:wave: Before I can help, please agree to *${env.BOT_DISPLAY_NAME}'s privacy policy*. ` +
          `In short: I store messages in conversations I'm part of (for 30 days), remember facts about you to personalise answers ` +
          `(you can see and delete them in my App Home), and send what you ask to AI model providers to answer. ` +
          `You can withdraw and delete your data any time in my App Home. ` +
          `I'll get to your message as soon as you agree.`,
      },
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: PRIVACY_AGREE_ACTION, text: { type: 'plain_text', text: 'I agree' }, style: 'primary', value: privacyPolicy().version },
        { type: 'button', action_id: PRIVACY_READ_ACTION, text: { type: 'plain_text', text: 'Read the privacy policy' }, value: 'read' },
      ],
    },
  ];
}

const SECTION_MAX = 2900;
const MODAL_MAX_BLOCKS = 100;

/** Markdown inline syntax → Slack mrkdwn (bold, italics, links, code; `&<>` escaped outside link targets). */
export function inlineToMrkdwn(s: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const out: string[] = [];
  // Links and code spans first, so their contents are left alone.
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    out.push(emphasis(esc(s.slice(last, m.index))));
    out.push(m[1] !== undefined ? `<${m[2]}|${esc(m[1])}>` : `\`${esc(m[3]!)}\``);
    last = m.index + m[0].length;
  }
  out.push(emphasis(esc(s.slice(last))));
  return out.join('');
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `\u0000${a ?? b}\u0000`)
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1_$2_')
    .replace(/\u0000/g, '*');
}

/**
 * The policy as modal blocks: `#` headings become header blocks (≤ 150 chars), everything else mrkdwn sections split
 * at paragraph boundaries (≤ SECTION_MAX chars each); list markers become bullets.
 */
export function policyBlocks(md: string): unknown[] {
  const blocks: unknown[] = [];
  let buf: string[] = [];
  const flush = () => {
    let text = buf.join('\n').trim();
    buf = [];
    while (text) {
      let cut = text.length <= SECTION_MAX ? text.length : text.lastIndexOf('\n', SECTION_MAX);
      if (cut <= 0) cut = SECTION_MAX;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, cut) } });
      text = text.slice(cut).trim();
    }
  };
  for (const line of md.split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const title = h[2]!.replace(/[*_`]/g, '').trim();
      if (h[1]!.length <= 2) blocks.push({ type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } });
      else buf.push(`*${inlineToMrkdwn(title)}*`);
      continue;
    }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    buf.push(li ? `${li[1]}• ${inlineToMrkdwn(li[2]!)}` : inlineToMrkdwn(line));
  }
  flush();
  return blocks.slice(0, MODAL_MAX_BLOCKS);
}

/**
 * "Read the privacy policy": open it in a modal. The click's trigger_id expires 3 s after the click (a queue backlog
 * can miss that): then it's posted as an ephemeral message instead (≤ 50 blocks there), or DMed from App Home.
 */
export async function handlePrivacyRead(ctx: ActionContext): Promise<void> {
  const blocks = policyBlocks(privacyPolicy().text);
  if (ctx.triggerId) {
    try {
      await slackCall('views.open', {
        trigger_id: ctx.triggerId,
        view: { type: 'modal', title: { type: 'plain_text', text: 'Privacy policy' }, close: { type: 'plain_text', text: 'Close' }, blocks },
      });
      return;
    } catch (err) {
      log.warn({ err }, 'privacy policy modal failed; posting it instead');
    }
  }
  const text = `${env.BOT_DISPLAY_NAME}'s privacy policy`;
  if (await respond(ctx.responseUrl, { response_type: 'ephemeral', replace_original: false, text, blocks: blocks.slice(0, 50) })) return;
  // App Home clicks carry no response_url: DM it.
  await slackCall('chat.postMessage', { channel: ctx.userId, text, blocks: blocks.slice(0, 50) }).catch((err) => log.warn({ err }, 'privacy policy DM failed'));
}
