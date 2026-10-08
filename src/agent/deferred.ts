/**
 * Background work a subagent run started but doesn't wait for (today: Slack searches that would sit out the shared
 * rate limiter). A tool hands a job to the run's queue (ctx.extras[SEARCH_DEFER_EXTRA]) and returns at once; the runner
 * (child.ts) adds finished results to the conversation at the next step boundary, the model can block on them with
 * wait_for_searches, and a run that tries to finish while some are pending waits for them first.
 */
import { errMsg } from '../tools/util.js';
import type { DeferFn } from '../tools/slack-search.js';

interface Done {
  id: string;
  label: string;
  text: string;
}

export class DeferredQueue {
  private n = 0;
  private pending = new Map<string, { label: string; settled: Promise<void> }>();
  private ready: Done[] = [];
  private readonly controller = new AbortController();

  /** `parent`: the run's abort signal (cancel, timeout, shutdown) also stops the jobs. */
  constructor(
    private readonly max: number,
    parent?: AbortSignal,
  ) {
    if (parent?.aborted) this.controller.abort(parent.reason);
    else parent?.addEventListener('abort', () => this.controller.abort(parent.reason), { once: true });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Jobs pending or finished but not yet handed to the model. */
  get outstanding(): number {
    return this.pending.size + this.ready.length;
  }

  readonly defer: DeferFn = (job) => {
    if (this.controller.signal.aborted || this.pending.size >= this.max) return null;
    const id = `S${++this.n}`;
    const signal = this.controller.signal;
    const settled = Promise.resolve()
      .then(() => job.run(signal))
      .catch((err) => (signal.aborted ? null : `Failed: ${errMsg(err)}`))
      .then((text) => {
        this.pending.delete(id);
        if (text !== null) this.ready.push({ id, label: job.label, text });
      });
    this.pending.set(id, { label: job.label, settled });
    return id;
  };

  /** The finished jobs' results as one model-facing block (and forget them), or null when none finished. */
  take(): string | null {
    if (!this.ready.length) return null;
    const done = this.ready.splice(0);
    return done.map((d) => `[Background search ${d.id}: "${d.label}"]\n${d.text}`).join('\n\n');
  }

  /** Labels of the jobs still running, e.g. `S2 "query"`. */
  pendingLabels(): string[] {
    return [...this.pending].map(([id, p]) => `${id} "${p.label}"`);
  }

  /** Resolves once a result is ready (or nothing is pending), or after `maxMs`, or when `signal` fires. */
  async waitAny(maxMs: number, signal?: AbortSignal): Promise<void> {
    if (this.ready.length || !this.pending.size) return;
    await race([...this.pending.values()].map((p) => p.settled), maxMs, signal);
  }

  /** Resolves once every pending job settled (each has its own wait cap), after `maxMs`, or when `signal` fires. */
  async waitAll(maxMs: number, signal?: AbortSignal): Promise<void> {
    if (!this.pending.size) return;
    await race([Promise.all([...this.pending.values()].map((p) => p.settled))], maxMs, signal);
  }

  /** The run is over: stop the jobs still running. */
  close(): void {
    this.controller.abort(new Error('run finished'));
  }
}

function race(ps: Promise<unknown>[], maxMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = Number.isFinite(maxMs) ? setTimeout(done, maxMs) : undefined;
    signal?.addEventListener('abort', done, { once: true });
    for (const p of ps) p.then(done, done);
    function done() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
