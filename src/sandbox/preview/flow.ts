/**
 * Live preview flow (docs/sandbox.md §3.6). Inline (the usual path): request_preview in the subagent's run checks
 * (entry, kill switches, access, budget, Cloudflare terms, waiting a little for a first-time terms answer) and deploys
 * by code, then returns the URL and preview id; the front agent posts the link with `reply(preview)`, which adds the
 * "Get claim link" + Report buttons. Late (terms answered after the tool stopped waiting, or a request left when the
 * run ended): prepare → deploy job → an outcome turn tells the front agent (fallback: the code-posted preview
 * message). Also expiry and the button handlers. The claim URL is a bearer credential: only the requester's own click
 * shows it, ephemerally; it never reaches the model, thread events or logs.
 */
import { env, limits } from '../../config.js';
import type { ActionContext } from '../../core/actions.js';
import { appendEvent, parseThreadId, threadTsArg } from '../../core/events.js';
import { enqueue, QUEUE } from '../../core/queues.js';
import { slackCall } from '../../core/slack.js';
import { sql } from '../../db/index.js';
import { checkEntry } from '../../features/guard.js';
import { registerOutcomeFallback, registerOutcomeObsolete, settleWithOutcome } from '../../features/outcome-turn.js';
import { hasAgreed } from '../../features/privacy.js';
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
import { postPreviewMessage, previewMessage } from './reply-blocks.js';
import { readTar } from './tar.js';
import { ACTIVE, acceptTerms, apiTokenOf, claimUrlOf, getPreview, setInlineUntil, setMessageTs, storeLive, termsAccepted, transition, type PreviewRow } from './store.js';

export const CF_TERMS_URL = 'https://www.cloudflare.com/terms/';
export const CF_PRIVACY_URL = 'https://www.cloudflare.com/privacypolicy/';

/** Use the fixed Worker in front of the assets (false: assets-only fallback, docs/sandbox.md §3.6). */
export const PREVIEW_WITH_WORKER = process.env.PREVIEW_ASSETS_ONLY !== '1';

const threadOf = (row: PreviewRow) => parseThreadId(row.threadId);
/** Button answers go to the preview's thread (features/util.ts ephemeral), not the channel / DM root. */
const inThread = (row: PreviewRow) => ({ threadTs: threadOf(row).threadTs });

async function tellRequester(row: PreviewRow, text: string, blocks?: unknown[]): Promise<void> {
  const { channelId, threadTs } = threadOf(row);
  await slackCall('chat.postEphemeral', { channel: channelId, user: row.requesterId, ...threadTsArg(threadTs), text, ...(blocks ? { blocks } : {}) }).catch((err) =>
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

/**
 * Called when a sandbox subagent's run ends. A request still pending (the tool didn't get to deploy it) is deployed by
 * the jobs after a complete run; after any other ending, pending requests (incl. an unanswered terms prompt) are dropped.
 */
export async function onRunFinishedPreview(runId: number, status: string): Promise<void> {
  const rows = await sql<PreviewRow[]>`select * from previews where run_id = ${runId} and status in ('requested', 'awaiting_terms')`;
  for (const row of rows) {
    if (status !== 'complete') await endEarly(row, 'cancelled');
    else if (row.status === 'requested') await enqueue(QUEUE.sandbox, { type: 'preview-prepare', previewId: row.id }, { jobId: `preview-prepare-${row.id}`, attempts: 1 });
  }
}

/**
 * Entry, kill switches, access and budget for a requested preview: null = go on, else why not (the row is ended).
 * `quiet`: the requester can't use the bot right now (paused, suspended…), so nobody is told.
 */
async function preflight(row: PreviewRow): Promise<{ problem: string; quiet?: boolean } | null> {
  const { channelId } = threadOf(row);
  const entry = await checkEntry(row.requesterId, channelId, { countMessage: false });
  if (!entry.ok) {
    await endEarly(row, 'cancelled', `entry: ${entry.reason}`);
    return { problem: `the requester can't use the bot right now (${entry.reason}).`, quiet: true };
  }
  const settings = await sandboxSettings();
  if (settings.previewsDisabled || (settings.disabled && !isAdmin(row.requesterId))) {
    await endEarly(row, 'cancelled', 'previews disabled');
    return { problem: 'previews are turned off right now.' };
  }
  const access = await canUseSandbox(row.requesterId);
  if (!access.ok) {
    await endEarly(row, 'cancelled', `access: ${access.reason}`);
    return { problem: accessExplanation(access.reason) };
  }
  if (!(await budgetStatus()).canStart) {
    await endEarly(row, 'cancelled', 'budget');
    return { problem: accessExplanation('budget') };
  }
  return null;
}

/** preview-prepare job (late path): the checks, then the terms prompt or the deploy job. */
export async function preparePreview(previewId: string): Promise<void> {
  const row = await getPreview(previewId);
  if (!row || row.status !== 'requested') return;
  const pre = await preflight(row);
  if (pre) {
    if (!pre.quiet) await announceFailed(row, `it wasn't deployed: ${pre.problem}`);
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

type DeployOutcome = { ok: true; live: PreviewRow } | { ok: false; refused: boolean; reason: string } | { ok: false; skipped: true };

/** Deploy a `requested` preview (claimed atomically). Never posts anything; the caller tells the thread. */
async function deployCore(previewId: string): Promise<DeployOutcome> {
  const row = await transition(previewId, ['requested'], 'deploying');
  if (!row) return { ok: false, skipped: true };
  try {
    const bundle = row.bundleFileId ? await fileStore.get(row.bundleFileId) : null;
    if (!bundle) throw new Error('the preview files are gone');
    const name = (await userProfile(row.requesterId)).name;
    const expiresAt = new Date(Date.now() + limits.previewLifetimeMs);
    const prepared = prepareBundle(readTar(bundle), { requester: `@${name}`, expiresAt, botName: env.BOT_DISPLAY_NAME });
    if (!prepared.ok) {
      const refused = prepared.kind === 'refused';
      await endEarly(row, refused ? 'refused' : 'failed', prepared.reason);
      return { ok: false, refused, reason: refused ? `it contains a login, password or payment form (${prepared.reason}); previews can't include those` : prepared.reason };
    }
    const workerName = `smasnug-p-${row.id.replace(/^pv_/, '').toLowerCase()}`;
    const res = await previewDeployer.deploy({ previewId: row.id, workerName, files: prepared.files, withWorker: PREVIEW_WITH_WORKER, userId: row.requesterId, threadId: row.threadId, wranglerVersion: env.WRANGLER_VERSION });
    const live = await storeLive(row.id, res);
    await dropBundle(row);
    if (!live) return { ok: false, skipped: true };
    await appendEvent(live.threadId, 'preview_live', 'system', { previewId: live.id, url: live.url, expiresAt: live.expiresAt });
    if (live.runId) {
      // The URL joins the run's sources (shown on its card row).
      const [run] = await sql<{ cardId: number | null }[]>`
        update runs set sources = coalesce(sources, '[]'::jsonb) || ${sql.json([{ url: live.url!, title: `Live preview: ${live.title}` }] as any)}::jsonb
        where id = ${live.runId} returning card_id`;
      if (run?.cardId) await scheduleCardRender(Number(run.cardId));
    }
    return { ok: true, live };
  } catch (err) {
    log.warn({ previewId, err: String((err as any)?.message ?? err).slice(0, 300) }, 'preview deploy failed');
    await endEarly(row, 'failed', String((err as any)?.message ?? err).slice(0, 500));
    return { ok: false, refused: false, reason: 'something went wrong on the way to Cloudflare' };
  }
}

/** preview-deploy job (late path): deploy, then tell the front agent (an outcome turn). */
export async function deployPreview(previewId: string): Promise<void> {
  const res = await deployCore(previewId);
  if (res.ok) return announceLive(res.live);
  if ('skipped' in res) return;
  const row = await getPreview(previewId);
  if (row) await announceFailed(row, res.refused ? `it wasn't deployed: ${res.reason}.` : `it couldn't be deployed: ${res.reason}.`);
}

const cleanTitle = (t: string) => t.replace(/[<>&*_~`"]/g, '');
const hhmmUtc = (d: Date | null) => `${(d ?? new Date()).toISOString().slice(11, 16)} UTC`;

/**
 * A preview went live outside its request_preview call (a late terms answer, or a call that was aborted): an outcome
 * turn has the front agent post it (fallback: our message).
 */
async function announceLive(row: PreviewRow): Promise<void> {
  // Already posted (a reply with `preview`, or the results turn's safety net): nothing to announce.
  if ((await getPreview(row.id))?.announcedAt) return;
  const fallback = `Live preview of ${cleanTitle(row.title)}: ${row.url} · expires ${hhmmUtc(row.expiresAt)}`;
  if (!(await hasAgreed(row.requesterId).catch(() => false))) {
    await postPreviewMessage(row);
    return;
  }
  const input = [
    `<preview id="${row.id}" status="live">`,
    `System notice (not a message from <@${row.requesterId}>): the live preview "${cleanTitle(row.title)}" a subagent built for <@${row.requesterId}> is now deployed: ${row.url} (expires ${hhmmUtc(row.expiresAt)}, unless claimed).`,
    '</preview>',
    `Post the link now in one short reply with preview: "${row.id}" (that adds the "Get claim link" button only they can use), unless a message in the thread already shows this link with its claim button. Don't start new work.`,
  ].join('\n');
  const r = await settleWithOutcome({ threadId: row.threadId, speakerId: row.requesterId, source: 'preview', sourceRef: row.id, input, fallback, isMention: true, transition: async () => true }).catch((err) => {
    log.warn({ err, previewId: row.id }, 'preview live turn failed');
    return null;
  });
  if (!r?.turnId) await postPreviewMessage(row);
}

/** request_preview's text while the terms prompt is unanswered. */
function waitingText(row: Pick<PreviewRow, 'id' | 'requesterId'>): string {
  return (
    `Preview waiting: <@${row.requesterId}> hasn't accepted Cloudflare's terms yet (a prompt only they see is in the thread). ` +
    `When they accept, it deploys and the link is posted in the thread. Say so in your result (the preview id is ${row.id}); don't request it again.`
  );
}

const untrustedTitle = (t: string) => `Title (written by the subagent): "${cleanTitle(t)}"`;

/** A late deploy didn't happen: the front agent says so (fallback: the text). */
async function announceFailed(row: PreviewRow, what: string): Promise<void> {
  const text = `The live preview of “${row.title}” ${what}`;
  if (!(await hasAgreed(row.requesterId).catch(() => false))) return tellRequester(row, text);
  const input = [
    `<preview id="${row.id}" status="${row.status}">`,
    untrustedTitle(row.title),
    `System notice (not a message from <@${row.requesterId}>): the live preview a subagent built for <@${row.requesterId}> ${what}`,
    '</preview>',
    'Tell them briefly; offer the source files instead if they were exported. Don\'t retry on your own.',
  ].join('\n');
  const r = await settleWithOutcome({ threadId: row.threadId, speakerId: row.requesterId, source: 'preview', sourceRef: row.id, input, fallback: text, isMention: true, transition: async () => true }).catch((err) => {
    log.warn({ err, previewId: row.id }, 'preview failure turn failed');
    return null;
  });
  if (!r?.turnId) await tellRequester(row, text);
}

/** When the live-preview outcome turn runs: moot if the preview was posted meanwhile (or is no longer live). */
registerOutcomeObsolete('preview', async (sourceRef) => {
  const row = sourceRef ? await getPreview(sourceRef) : null;
  if (!row || row.status !== 'live') return null; // a failure notice, or gone: keep the stored input
  if (!row.announcedAt) return null;
  return `System notice: the live preview ${row.id} (${row.url}) is already posted in this thread with its claim button. Nothing to do: call end_turn.`;
});

/** An outcome turn for a live preview that showed nothing: post the code message with its buttons instead. */
registerOutcomeFallback('preview', async (sourceRef) => {
  const row = sourceRef ? await getPreview(sourceRef) : null;
  if (!row || row.status !== 'live' || !row.url) return null;
  const m = previewMessage(row);
  // (A moot turn has no fallback, so an announced preview never gets here.)
  return { ...m, onPosted: (ts) => setMessageTs(row.id, ts) };
});

// ---------- inline (request_preview) ----------

/** What request_preview says after a deploy (the model text). */
function liveText(row: PreviewRow): string {
  return (
    `Deployed: ${row.url} (preview id ${row.id}, live until ${hhmmUtc(row.expiresAt)} unless claimed). ` +
    `Check it renders (fetch the URL or screenshot it); if it's broken, fix the site and call request_preview again. ` +
    `In your result give the URL and the preview id: the front agent posts the link with the claim button.`
  );
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * request_preview's deploy: checks, the terms (a first-time requester gets the prompt; the call waits up to
 * `limits.previewTermsWaitMs` for the answer), then the deploy. Returns the text for the model. A terms answer after
 * the wait is handled by the late path (the accept handler queues the deploy; the front agent is told).
 */
export async function deployInline(previewId: string, o: { abortSignal?: AbortSignal; pollMs?: number; waitMs?: number } = {}): Promise<string> {
  let row = await getPreview(previewId);
  // Requested again while the terms prompt is open: the new files replaced the old ones; still waiting.
  if (row?.status === 'awaiting_terms') return waitingText(row);
  if (!row || row.status !== 'requested') return 'Preview not deployed: it is no longer pending.';
  const pre = await preflight(row);
  if (pre) return `Preview not deployed: ${pre.problem} Export the files instead and say so.`;
  if (!(await termsAccepted(row.requesterId))) {
    const waitMs = o.waitMs ?? limits.previewTermsWaitMs;
    const deadline = Date.now() + waitMs;
    // The mark outlives the wait a little, so a click right at the end still leaves the deploy to this call.
    const r = await transition(row.id, ['requested'], 'awaiting_terms', { termsPromptExpiresAt: new Date(Date.now() + limits.previewTermsTtlMs), inlineUntil: new Date(deadline + 30_000) });
    if (!r) return 'Preview not deployed: it is no longer pending.';
    await tellRequester(r, termsText(r), termsBlocks(r));
    let status = r.status;
    const pollMs = o.pollMs ?? Math.min(2000, Math.max(50, waitMs / 10));
    while (status === 'awaiting_terms' && Date.now() < deadline && !o.abortSignal?.aborted) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), o.abortSignal);
      status = (await getPreview(previewId))?.status ?? 'cancelled';
    }
    // Stop waiting; whatever the status is now, the accept handler saw the mark (no job) or sees it gone (job).
    status = (await setInlineUntil(previewId, null)) ?? 'cancelled';
    if (status === 'awaiting_terms') return waitingText(row);
    if (status !== 'requested') return 'Preview not deployed: the terms were declined or the request ended. Export the files instead and say so.';
  }
  // The run was stopped meanwhile: nobody would get the result.
  if (o.abortSignal?.aborted) {
    const r = await getPreview(previewId);
    if (r) await endEarly(r, 'cancelled', 'run aborted');
    return 'Preview not deployed: the run was stopped.';
  }
  const res = await deployCore(previewId);
  if (res.ok) {
    // Stopped while deploying: the result never reaches the front agent, so tell it like a late deploy.
    if (o.abortSignal?.aborted) await announceLive(res.live).catch((err) => log.warn({ err, previewId }, 'announcing an aborted inline deploy failed'));
    return liveText(res.live);
  }
  if ('skipped' in res) {
    row = await getPreview(previewId);
    return row?.status === 'live' ? liveText(row) : 'Preview not deployed: it is no longer pending.';
  }
  return res.refused ? `Preview refused: ${res.reason}. Remove that form and request again, or export the files instead.` : `Preview deploy failed: ${res.reason}. Try request_preview once more; if it fails again, export the files and say so.`;
}

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
    // No message edit: the link usually sits in the front agent's reply; its claim button then says it expired.
    if (r) await appendEvent(r.threadId, 'preview_expired', 'system', { previewId: r.id }).catch(() => {});
  }
}

// ---------- buttons ----------

export async function handleTermsAccept(ctx: ActionContext): Promise<void> {
  const row = await getPreview(ctx.value ?? '');
  if (!row || row.requesterId !== ctx.userId) return ephemeral(ctx, 'This button is for someone else.');
  if (row.status !== 'awaiting_terms') return ephemeral(ctx, 'This preview is no longer waiting for an answer.', { replace: true, ...inThread(row) });
  await acceptTerms(ctx.userId);
  const r = await transition(row.id, ['awaiting_terms'], 'requested', { termsPromptExpiresAt: null });
  if (!r) return;
  await ephemeral(ctx, `Thanks. Deploying the live preview of “${row.title}”; the link appears in the thread in a minute.`, { replace: true, ...inThread(row) });
  // A request_preview call still waiting for this answer deploys it itself (inline_until, cleared when it stops).
  if (!acceptedInline(r)) await enqueueDeploy(r.id);
}

/** Whether a request_preview call is still waiting for the terms answer (it deploys; no job). */
export function acceptedInline(r: Pick<PreviewRow, 'inlineUntil'>, now = Date.now()): boolean {
  return Boolean(r.inlineUntil && new Date(r.inlineUntil).getTime() > now);
}

export { previewMessage };

export async function handleTermsCancel(ctx: ActionContext): Promise<void> {
  const row = await getPreview(ctx.value ?? '');
  if (!row || row.requesterId !== ctx.userId) return ephemeral(ctx, 'This button is for someone else.');
  if (row.status === 'awaiting_terms') await endEarly(row, 'cancelled', 'declined terms');
  if (!(await deleteOriginal(ctx))) await ephemeral(ctx, 'OK, no preview.', { replace: true, ...inThread(row) });
}

export async function handleClaim(ctx: ActionContext): Promise<void> {
  const row = await getPreview(ctx.value ?? '');
  if (!row) return ephemeral(ctx, 'This preview no longer exists.');
  if (row.requesterId !== ctx.userId) return ephemeral(ctx, `Only <@${row.requesterId}> can claim this preview.`, inThread(row));
  if (row.status !== 'live' || !row.claimExpiresAt || row.claimExpiresAt.getTime() <= Date.now()) return ephemeral(ctx, 'This preview can no longer be claimed.', inThread(row));
  const url = claimUrlOf(row);
  log.info({ previewId: row.id }, 'preview claim link shown');
  if (!url) return ephemeral(ctx, "I don't have a claim link for this preview.", inThread(row));
  await ephemeral(
    ctx,
    `Claim link for “${row.title}”: ${url}\nAnyone with this link can take ownership of the site, so don't share it. Claiming moves it into your own Cloudflare account (sign-up is free; Cloudflare's own age rules apply).`,
    inThread(row),
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
  await ephemeral(ctx, 'Thanks, reported.', inThread(row));
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
