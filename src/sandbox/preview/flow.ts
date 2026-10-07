/**
 * Live preview flow (docs/sandbox.md §3.6): request (in the run) → run finished → prepare (entry, kill switches,
 * access, budget, Cloudflare terms) → deploy (code, never a model tool) → preview message with "Get claim link" +
 * Report → expiry. Also the button handlers. The claim URL is a bearer credential: only the requester's own click
 * shows it, ephemerally; it never reaches the model, thread events or logs.
 */
import { env, limits } from '../../config.js';
import type { ActionContext } from '../../core/actions.js';
import { appendEvent, parseThreadId } from '../../core/events.js';
import { enqueue, QUEUE } from '../../core/queues.js';
import { slackCall } from '../../core/slack.js';
import { sql } from '../../db/index.js';
import { checkEntry } from '../../features/guard.js';
import { confirmDialog } from '../../features/reports.js';
import { deleteOriginal, ephemeral, isAdmin, postToModChannel, requireAdmin, userProfile } from '../../features/util.js';
import { fileStore } from '../../files/store.js';
import { log } from '../../log.js';
import { scheduleCardRender } from '../../agent/cards.js';
import { accessExplanation, canUseSandbox } from '../access.js';
import { budgetStatus } from '../budget.js';
import { sandboxSettings } from '../settings.js';
import { prepareBundle } from './bundle.js';
import { previewDeployer } from './deploy.js';
import { readTar } from './tar.js';
import { ACTIVE, acceptTerms, apiTokenOf, claimUrlOf, getPreview, setMessageTs, storeLive, termsAccepted, transition, type PreviewRow } from './store.js';

export const CF_TERMS_URL = 'https://www.cloudflare.com/terms/';
export const CF_PRIVACY_URL = 'https://www.cloudflare.com/privacypolicy/';

/** Use the fixed Worker in front of the assets (false: assets-only fallback, docs/sandbox.md §3.6). */
export const PREVIEW_WITH_WORKER = process.env.PREVIEW_ASSETS_ONLY !== '1';

const threadOf = (row: PreviewRow) => parseThreadId(row.threadId);

async function tellRequester(row: PreviewRow, text: string, blocks?: unknown[]): Promise<void> {
  const { channelId, threadTs } = threadOf(row);
  await slackCall('chat.postEphemeral', { channel: channelId, user: row.requesterId, thread_ts: threadTs, text, ...(blocks ? { blocks } : {}) }).catch((err) =>
    log.warn({ err, previewId: row.id }, 'preview ephemeral failed'),
  );
}

async function dropBundle(row: Pick<PreviewRow, 'bundleFileId'>): Promise<void> {
  if (row.bundleFileId) await fileStore.delete(row.bundleFileId).catch(() => {});
}

/** End a preview that never went live: status, bundle gone. */
async function endEarly(row: PreviewRow, to: 'cancelled' | 'failed' | 'refused', error?: string): Promise<PreviewRow | null> {
  const r = await transition(row.id, ['requested', 'awaiting_terms', 'deploying'], to, { error: error ?? null });
  if (r) {
    await dropBundle(r);
    await appendEvent(r.threadId, `preview_${to}`, 'system', { previewId: r.id }).catch(() => {});
  }
  return r;
}

/** Called when a sandbox subagent's run ends: deploy only after a complete run, otherwise the request is dropped. */
export async function onRunFinishedPreview(runId: number, status: string): Promise<void> {
  const [row] = await sql<PreviewRow[]>`select * from previews where run_id = ${runId} and status = 'requested'`;
  if (!row) return;
  if (status !== 'complete') {
    await endEarly(row, 'cancelled');
    return;
  }
  await enqueue(QUEUE.sandbox, { type: 'preview-prepare', previewId: row.id }, { jobId: `preview-prepare-${row.id}`, attempts: 1 });
}

/** preview-prepare job: entry checks, kill switches, access, budget, terms. */
export async function preparePreview(previewId: string): Promise<void> {
  const row = await getPreview(previewId);
  if (!row || row.status !== 'requested') return;
  const { channelId } = threadOf(row);
  const entry = await checkEntry(row.requesterId, channelId, { countMessage: false });
  if (!entry.ok) {
    await endEarly(row, 'cancelled', `entry: ${entry.reason}`);
    return;
  }
  const settings = await sandboxSettings();
  if (settings.previewsDisabled || (settings.disabled && !isAdmin(row.requesterId))) {
    await endEarly(row, 'cancelled', 'previews disabled');
    await tellRequester(row, `The live preview of “${row.title}” wasn't deployed: previews are turned off right now.`);
    return;
  }
  const access = await canUseSandbox(row.requesterId);
  if (!access.ok) {
    await endEarly(row, 'cancelled', `access: ${access.reason}`);
    await tellRequester(row, `The live preview of “${row.title}” wasn't deployed. ${accessExplanation(access.reason)}`);
    return;
  }
  if (!(await budgetStatus()).canStart) {
    await endEarly(row, 'cancelled', 'budget');
    await tellRequester(row, `The live preview of “${row.title}” wasn't deployed. ${accessExplanation('budget')}`);
    return;
  }
  if (!(await termsAccepted(row.requesterId))) {
    const until = new Date(Date.now() + limits.previewTermsTtlMs);
    const r = await transition(row.id, ['requested'], 'awaiting_terms', { termsPromptExpiresAt: until });
    if (r) await tellRequester(r, termsText(r), termsBlocks(r));
    return;
  }
  await enqueueDeploy(row.id);
}

const enqueueDeploy = (id: string) => enqueue(QUEUE.sandbox, { type: 'preview-deploy', previewId: id }, { jobId: `preview-deploy-${id}`, attempts: 1 });

export function termsText(row: Pick<PreviewRow, 'title'>): string {
  return (
    `Your live preview of “${row.title}” is ready to deploy. It goes to Cloudflare as a temporary deployment: a temporary Cloudflare account is created for it in your name, ` +
    `the site is public for 60 minutes, and you can claim it into your own Cloudflare account to keep it. This needs your OK to Cloudflare's ` +
    `Terms (${CF_TERMS_URL}) and Privacy Policy (${CF_PRIVACY_URL}). Files of the preview leave Slack for Cloudflare (code you run in sandboxes runs on Modal, US).`
  );
}

export function termsBlocks(row: Pick<PreviewRow, 'id' | 'title'>): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `Your live preview of *${row.title.replace(/[<>&*_~`]/g, '')}* is ready to deploy.\n` +
          `It goes to *Cloudflare* as a temporary deployment: a temporary Cloudflare account is created for it in your name, the site is public for *60 minutes*, ` +
          `and you can claim it into your own Cloudflare account to keep it. Continuing means you accept Cloudflare's <${CF_TERMS_URL}|Terms> and <${CF_PRIVACY_URL}|Privacy Policy>. ` +
          `(Preview files go to Cloudflare; code you run in sandboxes runs on Modal, in the US.)`,
      },
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'preview:terms_accept', text: { type: 'plain_text', text: 'Accept and deploy' }, style: 'primary', value: row.id },
        { type: 'button', action_id: 'preview:terms_cancel', text: { type: 'plain_text', text: 'Cancel' }, value: row.id },
      ],
    },
  ];
}

/** preview-deploy job. */
export async function deployPreview(previewId: string): Promise<void> {
  const claimed = await transition(previewId, ['requested'], 'deploying');
  if (!claimed) return;
  const row = claimed;
  try {
    const bundle = row.bundleFileId ? await fileStore.get(row.bundleFileId) : null;
    if (!bundle) throw new Error('the preview files are gone');
    const name = (await userProfile(row.requesterId)).name;
    const expiresAt = new Date(Date.now() + limits.previewLifetimeMs);
    const prepared = prepareBundle(readTar(bundle), { requester: `@${name}`, expiresAt, botName: env.BOT_DISPLAY_NAME });
    if (!prepared.ok) {
      await endEarly(row, prepared.kind === 'refused' ? 'refused' : 'failed', prepared.reason);
      await tellRequester(
        row,
        prepared.kind === 'refused'
          ? `The live preview of “${row.title}” wasn't deployed: it contains a login, password or payment form (${prepared.reason}). Previews can't include those.`
          : `The live preview of “${row.title}” couldn't be deployed: ${prepared.reason}`,
      );
      return;
    }
    const workerName = `smasnug-p-${row.id.replace(/^pv_/, '').toLowerCase()}`;
    const res = await previewDeployer.deploy({ previewId: row.id, workerName, files: prepared.files, withWorker: PREVIEW_WITH_WORKER, userId: row.requesterId, threadId: row.threadId, wranglerVersion: env.WRANGLER_VERSION });
    const live = await storeLive(row.id, res);
    await dropBundle(row);
    if (!live) return;
    await appendEvent(live.threadId, 'preview_live', 'system', { previewId: live.id, url: live.url, expiresAt: live.expiresAt });
    await postPreviewMessage(live);
    if (live.runId) {
      // The URL joins the run's sources (shown on its card row).
      const [run] = await sql<{ cardId: number | null }[]>`
        update runs set sources = coalesce(sources, '[]'::jsonb) || ${sql.json([{ url: live.url!, title: `Live preview: ${live.title}` }] as any)}::jsonb
        where id = ${live.runId} returning card_id`;
      if (run?.cardId) await scheduleCardRender(Number(run.cardId));
    }
  } catch (err) {
    log.warn({ previewId, err: String((err as any)?.message ?? err).slice(0, 300) }, 'preview deploy failed');
    const r = await endEarly(row, 'failed', String((err as any)?.message ?? err).slice(0, 500));
    if (r) await tellRequester(r, `The live preview of “${row.title}” couldn't be deployed (something went wrong on the way to Cloudflare). You can ask again.`);
  }
}

export function previewMessage(row: PreviewRow): { text: string; blocks: unknown[] } {
  const exp = row.expiresAt ?? new Date();
  const epoch = Math.floor(exp.getTime() / 1000);
  const hhmm = exp.toISOString().slice(11, 16);
  const title = row.title.replace(/[<>&*_~`]/g, '');
  const text = `Live preview of ${title} for <@${row.requesterId}>: ${row.url} · expires ${hhmm} UTC`;
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Live preview of *${title}* for <@${row.requesterId}>: <${row.url}> · expires <!date^${epoch}^{time}|${hhmm} UTC>` } },
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'preview:claim', text: { type: 'plain_text', text: 'Get claim link' }, value: row.id },
          { type: 'button', action_id: 'preview:report', text: { type: 'plain_text', text: 'Report' }, value: row.id },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Temporary Cloudflare deployment. Only <@${row.requesterId}> can claim it to keep it.` }] },
    ],
  };
}

async function postPreviewMessage(row: PreviewRow): Promise<void> {
  const { channelId, threadTs } = threadOf(row);
  const m = previewMessage(row);
  const res = await slackCall<any>('chat.postMessage', { channel: channelId, thread_ts: threadTs, text: m.text, blocks: m.blocks, unfurl_links: false, unfurl_media: false }, { idempotencyKey: `preview:${row.id}` });
  if (res?.ts) await setMessageTs(row.id, res.ts);
}

async function updateEndedMessage(row: PreviewRow, text: string): Promise<void> {
  if (!row.messageTs) return;
  const { channelId } = threadOf(row);
  await slackCall('chat.update', { channel: channelId, ts: row.messageTs, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }).catch((err) =>
    log.warn({ err, previewId: row.id }, 'preview message update failed'),
  );
}

/** `sandbox:previews` (every minute): unanswered terms prompts → cancelled; past expiry → expired; stuck deploys → failed. */
export async function expirePreviews(): Promise<void> {
  const stale = await sql<PreviewRow[]>`select * from previews where status = 'awaiting_terms' and terms_prompt_expires_at < now()`;
  for (const r of stale) await endEarly(r, 'cancelled', 'terms not answered');
  const stuck = await sql<PreviewRow[]>`select * from previews where status in ('deploying', 'requested') and created_at < now() - interval '2 hours'`;
  for (const r of stuck) await endEarly(r, 'failed', 'stuck');
  const expired = await sql<{ id: string }[]>`select id from previews where status = 'live' and expires_at < now()`;
  for (const { id } of expired) {
    const r = await transition(id, ['live'], 'expired');
    if (r) {
      await updateEndedMessage(r, `Live preview of *${r.title.replace(/[<>&*_~`]/g, '')}* for <@${r.requesterId}> has expired.`);
      await appendEvent(r.threadId, 'preview_expired', 'system', { previewId: r.id }).catch(() => {});
    }
  }
}

// ---------- buttons ----------

export async function handleTermsAccept(ctx: ActionContext): Promise<void> {
  const row = await getPreview(ctx.value ?? '');
  if (!row || row.requesterId !== ctx.userId) return ephemeral(ctx, 'This button is for someone else.');
  if (row.status !== 'awaiting_terms') return ephemeral(ctx, 'This preview is no longer waiting for an answer.', { replace: true });
  await acceptTerms(ctx.userId);
  const r = await transition(row.id, ['awaiting_terms'], 'requested', { termsPromptExpiresAt: null });
  if (!r) return;
  await ephemeral(ctx, `Thanks. Deploying the live preview of “${row.title}”; the link appears in the thread in a minute.`, { replace: true });
  await enqueueDeploy(r.id);
}

export async function handleTermsCancel(ctx: ActionContext): Promise<void> {
  const row = await getPreview(ctx.value ?? '');
  if (!row || row.requesterId !== ctx.userId) return ephemeral(ctx, 'This button is for someone else.');
  if (row.status === 'awaiting_terms') await endEarly(row, 'cancelled', 'declined terms');
  if (!(await deleteOriginal(ctx))) await ephemeral(ctx, 'OK, no preview.', { replace: true });
}

export async function handleClaim(ctx: ActionContext): Promise<void> {
  const row = await getPreview(ctx.value ?? '');
  if (!row) return ephemeral(ctx, 'This preview no longer exists.');
  if (row.requesterId !== ctx.userId) return ephemeral(ctx, `Only <@${row.requesterId}> can claim this preview.`);
  if (row.status !== 'live' || !row.claimExpiresAt || row.claimExpiresAt.getTime() <= Date.now()) return ephemeral(ctx, 'This preview can no longer be claimed.');
  const url = claimUrlOf(row);
  log.info({ previewId: row.id }, 'preview claim link shown');
  if (!url) return ephemeral(ctx, "I don't have a claim link for this preview.");
  await ephemeral(
    ctx,
    `Claim link for “${row.title}”: ${url}\nAnyone with this link can take ownership of the site, so don't share it. Claiming moves it into your own Cloudflare account (sign-up is free; Cloudflare's own age rules apply).`,
  );
}

export async function handleReport(ctx: ActionContext): Promise<void> {
  const row = await getPreview(ctx.value ?? '');
  if (!row) return ephemeral(ctx, 'This preview no longer exists.');
  await postToModChannel(
    `Preview reported by <@${ctx.userId}>`,
    [
      { type: 'section', text: { type: 'mrkdwn', text: `Live preview *${row.title.replace(/[<>&*_~`]/g, '')}* by <@${row.requesterId}> was reported by <@${ctx.userId}>.\n${row.url ?? '(no URL)'} · status ${row.status}` } },
      ...(row.status === 'live'
        ? [{ type: 'actions', elements: [{ type: 'button', action_id: 'preview:takedown', style: 'danger', text: { type: 'plain_text', text: 'Take down' }, value: row.id, confirm: confirmDialog('Take down this preview?', 'Deletes the site with its temporary Cloudflare token and ends the preview.', 'Take down') }] }]
        : []),
    ],
    `preview-report:${row.id}:${ctx.userId}`,
  );
  await ephemeral(ctx, 'Thanks, reported.');
}

/** Admin only (mod-channel report post, App Home). */
export async function handleTakedown(ctx: ActionContext): Promise<boolean> {
  if (!(await requireAdmin(ctx))) return false;
  const row = await getPreview(ctx.value ?? '');
  if (!row || !ACTIVE.includes(row.status)) {
    await ephemeral(ctx, 'That preview has already ended.');
    return false;
  }
  let deleted = false;
  const token = apiTokenOf(row);
  if (row.status === 'live' && token && row.accountId && row.workerName) deleted = await previewDeployer.takedown({ accountId: row.accountId, apiToken: token, workerName: row.workerName });
  const r = row.status === 'live' ? await transition(row.id, ['live'], 'taken_down') : await endEarly(row, 'cancelled', 'taken down');
  if (r) {
    await dropBundle(r);
    await updateEndedMessage(r, `Live preview of *${r.title.replace(/[<>&*_~`]/g, '')}* was taken down.`);
    await appendEvent(r.threadId, 'preview_taken_down', ctx.userId, { previewId: r.id, deleted }).catch(() => {});
  }
  await ephemeral(
    ctx,
    row.status !== 'live' || deleted
      ? 'Preview taken down.'
      : "Preview marked as taken down, but deleting the site with its temporary token failed; it still disappears when it expires (under 60 minutes).",
  );
  return true;
}
