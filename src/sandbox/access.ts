/**
 * Who may use a code sandbox (docs/sandbox.md §4.1): kill switch → budget → admin / allowlist → access mode → HCA.
 * Suspension and blocks are already handled by checkEntry before any turn runs. The decision is a pure function
 * (unit-tested); the explanation goes to the user only, ephemerally, at most once per cooldown. The model only learns
 * that it isn't available, never why (except for the non-personal `budget` and `disabled`).
 */
import { limits } from '../config.js';
import { redis } from '../core/redis.js';
import { slackCall } from '../core/slack.js';
import { sql } from '../db/index.js';
import { isAdmin } from '../features/util.js';
import { log } from '../log.js';
import { budgetStatus, nextMonthStart } from './budget.js';
import { checkHca, type HcaDecision, type HcaReason } from './hca.js';
import { sandboxSettings, type AccessMode } from './settings.js';

export type AccessReason = 'disabled' | 'budget' | HcaReason;
export type Access = { ok: true } | { ok: false; reason: AccessReason };

/**
 * Pure. `hca` is only called when everything before it allowed the check (so HCA isn't asked about admins or
 * allowlisted users, and not at all in allowlist-only mode).
 */
export async function decideAccess(o: {
  disabled: boolean;
  admin: boolean;
  budgetExhausted: boolean;
  allowlisted: boolean;
  mode: AccessMode;
  hca: () => Promise<HcaDecision>;
}): Promise<Access> {
  if (o.disabled && !o.admin) return { ok: false, reason: 'disabled' };
  if (o.budgetExhausted) return { ok: false, reason: 'budget' };
  if (o.admin || o.allowlisted) return { ok: true };
  if (o.mode === 'allowlist_only') return { ok: false, reason: 'denied' };
  return o.hca();
}

export async function isAllowlisted(userId: string): Promise<boolean> {
  const [r] = await sql`select 1 from sandbox_allowlist where user_id = ${userId}`;
  return !!r;
}

export async function canUseSandbox(userId: string): Promise<Access> {
  const [settings, budget, allowlisted] = await Promise.all([sandboxSettings(), budgetStatus(), isAllowlisted(userId)]);
  return decideAccess({
    disabled: settings.disabled,
    admin: isAdmin(userId),
    budgetExhausted: budget.exhausted,
    allowlisted,
    mode: settings.accessMode,
    hca: () => checkHca(userId),
  });
}

/** What the user is told (privately). */
export function accessExplanation(reason: AccessReason, now = new Date()): string {
  switch (reason) {
    case 'denied':
      return 'Code sandboxes need a verified Hack Club identity. Verify at https://auth.hackclub.com and link your Slack account there (older accounts can show as unverified until Slack is linked), then ask again.';
    case 'pending':
      return 'Your identity verification is still being reviewed; code sandboxes unlock once it is approved.';
    case 'rejected':
      return "Code sandboxes aren't available for your account. If you think that's wrong, ask in #identity-help.";
    case 'unavailable':
      return "I can't check code sandbox access right now. Try again in a few minutes.";
    case 'budget':
      return `Code sandboxes are paused until ${nextMonthStart(now).toISOString().slice(0, 10)}: this month's free compute is used up.`;
    case 'disabled':
      return 'Code sandboxes are turned off right now.';
  }
}

/** What the model is told. Personal reasons stay private. */
export function accessModelText(reason: AccessReason): string {
  if (reason === 'budget') return "Code sandboxes are paused until next month: this month's free compute is used up. You may tell the user that plainly.";
  if (reason === 'disabled') return 'Code sandboxes are turned off right now. You may tell the user that plainly.';
  return "Sandbox not available for this user right now; they were told why privately. Don't speculate about the reason in the thread.";
}

/** The ephemeral explanation, at most once per user per cooldown. Never posted for anyone but `userId`. */
export async function notifyAccess(o: { userId: string; channelId: string; threadTs?: string; reason: AccessReason }): Promise<void> {
  const fresh = await redis.set(`sandbox:notice:${o.userId}`, '1', 'PX', limits.sandboxNoticeCooldownMs, 'NX');
  if (fresh !== 'OK') return;
  await slackCall('chat.postEphemeral', {
    channel: o.channelId,
    user: o.userId,
    text: accessExplanation(o.reason),
    ...(o.threadTs ? { thread_ts: o.threadTs } : {}),
  }).catch((err) => log.warn({ err }, 'sandbox access ephemeral failed'));
}
