// Module registration (sandbox): tools, actions, the `sandbox` queue processor and maintenance tasks.
// Everything except the processor is skipped when the Modal credentials aren't set: the feature is fully off then
// (no tools, no jobs, no App Home section) and nothing touches Modal.
import type { Job } from 'bullmq';
import { registerAction } from '../core/actions.js';
import { QUEUE, type QueueName } from '../core/queues.js';
import { publishHome } from '../features/home.js';
import { postToModChannel } from '../features/util.js';
import { log } from '../log.js';
import { refreshBudget } from './budget.js';
import { handleSandboxAdminAction } from './home.js';
import { destroySandbox, pauseSandbox, reconcileSandboxes, sandboxRetention, sweepSandboxes } from './lifecycle.js';
import { deployPreview, expirePreviews, handleClaim, handleReport, handleTakedown, handleTermsAccept, handleTermsCancel, preparePreview } from './preview/flow.js';
import { ModalProvider } from './modal.js';
import { sandboxProvider } from './providers.js';
import { previewsConfigured, sandboxConfigured } from './settings.js';

const enabled = sandboxConfigured();

if (enabled) {
  await import('./tools.js');
  registerAction('sbx:', (ctx) => handleSandboxAdminAction(ctx, publishHome));
  if (previewsConfigured()) {
    registerAction('preview:terms_accept', handleTermsAccept);
    registerAction('preview:terms_cancel', handleTermsCancel);
    registerAction('preview:claim', handleClaim);
    registerAction('preview:report', handleReport);
    registerAction('preview:takedown', async (ctx) => void (await handleTakedown(ctx)));
  }
}

type SandboxJob =
  | { type: 'pause'; sandboxId: string; generation?: number; force?: boolean; minIdleMs?: number }
  | { type: 'destroy'; sandboxId: string }
  | { type: 'preview-prepare' | 'preview-deploy'; previewId: string };

export const processors: Partial<Record<QueueName, (job: Job) => Promise<void>>> = {
  // Always registered (an idle consumer), so the worker doesn't warn about an unconsumed queue when the feature is off.
  [QUEUE.sandbox]: async (job) => {
    if (!enabled) return;
    const d = job.data as SandboxJob;
    switch (d.type) {
      case 'pause':
        await pauseSandbox(d.sandboxId, { generation: d.generation, force: d.force, minIdleMs: d.minIdleMs });
        return;
      case 'destroy':
        await destroySandbox(d.sandboxId);
        return;
      case 'preview-prepare':
        await preparePreview(d.previewId);
        return;
      case 'preview-deploy':
        await deployPreview(d.previewId);
        return;
    }
  },
};

const notifyMods = (text: string) => postToModChannel(text, [{ type: 'section', text: { type: 'mrkdwn', text } }], `sandbox-budget:${new Date().toISOString().slice(0, 7)}:${text.slice(0, 40)}`).then(() => {});

/** Periodic tasks run via the `maintenance` queue: { [taskName]: { everyMs, run } }. */
export const maintenance: Record<string, { everyMs: number; run: () => Promise<void> }> = enabled
  ? {
      'sandbox:sweep': { everyMs: 30_000, run: async () => void (await sweepSandboxes()) },
      'sandbox:reconcile': {
        everyMs: 10 * 60_000,
        run: async () => {
          const r = await reconcileSandboxes();
          if (r.orphans || r.lost) log.info(r, 'sandbox reconcile');
        },
      },
      // Our estimate is live anyway (budgetStatus); this refreshes Modal's metered numbers and sends the notices.
      'sandbox:budget': {
        everyMs: 5 * 60_000,
        run: async () => {
          const p = sandboxProvider();
          await refreshBudget({ metered: p instanceof ModalProvider ? () => p.meteredSpend() : undefined, notify: notifyMods });
        },
      },
      ...(previewsConfigured() ? { 'sandbox:previews': { everyMs: 60_000, run: expirePreviews } } : {}),
      'sandbox:retention': { everyMs: 24 * 60 * 60 * 1000, run: sandboxRetention },
    }
  : {};

/** Called on SIGTERM before the worker exits. Sandboxes live on the provider; the sweep and reconcile handle them. */
export async function onShutdown(): Promise<void> {}
