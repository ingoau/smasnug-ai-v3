/**
 * Modal implementation of SandboxProvider (the `modal` npm SDK). Phase 0 spike results are in docs/sandbox.md §9.
 *
 * - Commands run as the unprivileged `sandbox` user (setpriv; Modal's exec has no user option), in their own process
 *   group with a pid file, under `timeout --kill-after=5`; the SDK's exec timeout is only a backstop (it throws
 *   "Deadline exceeded" instead of returning). An abort kills the process group through a second exec.
 * - Files go in through exec stdin as the `sandbox` user (owner and parent directories right) and come out through
 *   the SDK's filesystem API.
 * - Pause = snapshotFilesystem (an image, TTL 7 days) + terminate; resume = create from that image.
 * - Egress: `outboundCidrAllowlist` takes IPv4 CIDRs only ("Invalid CIDR (outbound IPv4)" for IPv6); with an
 *   allowlist set, IPv6 is unreachable.
 */
import { randomUUID } from 'node:crypto';
import { ModalClient, type App, type Image, type Sandbox } from 'modal';
import { env } from '../config.js';
import { log } from '../log.js';
import { deployImage, workImage, type ImageDef } from './image.js';
import { SandboxGoneError, shq, type ExecOptions, type ExecResult, type Handle, type ImageRef, type Paused, type SandboxProvider, type SandboxSpec } from './provider.js';

/** Snapshots outlive the subagent's 24 h idle expiry with room to spare; deletePaused removes them earlier. */
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BASE_ENV = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/work', LANG: 'C.UTF-8', TZ: 'UTC', NODE_PATH: '/usr/lib/node_modules', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' };
const AS_USER = ['setpriv', '--reuid=1000', '--regid=1000', '--init-groups', '--reset-env'];

function isGone(err: unknown): boolean {
  const m = String((err as any)?.message ?? err);
  return /NOT_FOUND|already shut down|has finished|terminated|not running/i.test(m) || (err as any)?.constructor?.name === 'NotFoundError';
}

/** Read a byte stream, keeping at most `max` bytes (the rest is drained and dropped). */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let kept = 0;
  let truncated = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    if (kept < max) {
      const take = Math.min(value.byteLength, max - kept);
      chunks.push(Buffer.from(value.subarray(0, take)));
      kept += take;
      if (take < value.byteLength) truncated = true;
    } else truncated = true;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

export class ModalProvider implements SandboxProvider {
  readonly name = 'modal' as const;
  #client: ModalClient | undefined;
  #app: Promise<App> | undefined;
  #images = new Map<string, Image>();
  #sandboxes = new Map<string, Sandbox>();

  private get client(): ModalClient {
    this.#client ??= new ModalClient({ tokenId: env.MODAL_TOKEN_ID, tokenSecret: env.MODAL_TOKEN_SECRET, environment: env.MODAL_ENVIRONMENT, logLevel: 'warn' as any });
    return this.#client;
  }

  private app(): Promise<App> {
    if (!this.#app) {
      this.#app = this.client.apps.fromName(env.MODAL_APP_NAME, { createIfMissing: true, environment: env.MODAL_ENVIRONMENT });
      this.#app.catch(() => (this.#app = undefined));
    }
    return this.#app;
  }

  private image(ref: ImageRef): Image {
    const def: ImageDef = ref.kind === 'deploy' ? deployImage() : workImage();
    let img = this.#images.get(def.name);
    if (!img) {
      img = this.client.images.fromRegistry(def.registry).dockerfileCommands(def.commands);
      this.#images.set(def.name, img);
    }
    return img;
  }

  private async sandbox(h: Handle): Promise<Sandbox> {
    const hit = this.#sandboxes.get(h.providerId);
    if (hit) return hit;
    try {
      const sb = await this.client.sandboxes.fromId(h.providerId);
      this.#sandboxes.set(h.providerId, sb);
      return sb;
    } catch (err) {
      if (isGone(err)) throw new SandboxGoneError();
      throw err;
    }
  }

  private async createFrom(image: Image, spec: SandboxSpec): Promise<Handle> {
    const sb = await this.client.sandboxes.create(await this.app(), image, {
      cpu: spec.cpu,
      cpuLimit: spec.cpuLimit,
      memoryMiB: spec.memoryMiB,
      memoryLimitMiB: spec.memoryLimitMiB,
      timeoutMs: spec.lifetimeMs,
      workdir: '/work',
      outboundCidrAllowlist: spec.egress.allowCidrs,
      tags: spec.tags,
    });
    this.#sandboxes.set(sb.sandboxId, sb);
    return { providerId: sb.sandboxId };
  }

  /** Build the work and deploy images ahead of use (`pnpm sandbox:images`): a first build takes ~13 minutes. */
  async buildImages(log_: (msg: string) => void = () => {}): Promise<void> {
    for (const ref of [{ kind: 'work' }, { kind: 'deploy' }] as ImageRef[]) {
      const started = Date.now();
      const img = await this.image(ref).build(await this.app());
      log_(`${ref.kind} image ready (${img.imageId.slice(0, 6)}…) in ${Math.round((Date.now() - started) / 1000)}s`);
    }
  }

  async create(spec: SandboxSpec): Promise<Handle> {
    return this.createFrom(this.image(spec.image), spec);
  }

  async resume(paused: Paused, spec: SandboxSpec): Promise<Handle> {
    const img = await this.client.images.fromId(paused.ref);
    return this.createFrom(img, spec);
  }

  async pause(h: Handle): Promise<Paused> {
    const sb = await this.sandbox(h);
    let img: Image;
    try {
      img = await sb.snapshotFilesystem({ ttlMs: SNAPSHOT_TTL_MS, timeoutMs: 120_000 });
    } catch (err) {
      if (isGone(err)) throw new SandboxGoneError();
      throw err;
    }
    await this.destroy(h);
    return { kind: 'fs-snapshot', ref: img.imageId, expiresAt: new Date(Date.now() + SNAPSHOT_TTL_MS) };
  }

  async exec(h: Handle, argv: string[], o: ExecOptions): Promise<ExecResult> {
    const sb = await this.sandbox(h);
    const started = Date.now();
    const id = randomUUID().slice(0, 12);
    const pidFile = `/tmp/.exec-${id}.pid`;
    const secs = Math.max(1, Math.ceil(o.timeoutMs / 1000));
    // setsid: its own process group (an abort kills the whole tree); the pid file names the group. `--wait`: setsid
    // forks when the caller leads a process group, and without it would return before the command finishes.
    const inner = ['setsid', '--wait', 'bash', '-c', `echo $$ > ${pidFile}; exec "$@"`, '_', 'timeout', '--kill-after=5', `${secs}s`, ...argv];
    const full = o.root ? ['env', '-i', ...Object.entries({ ...BASE_ENV, ...o.env }).map(([k, v]) => `${k}=${v}`), ...inner] : [...AS_USER, 'env', ...Object.entries({ ...BASE_ENV, ...o.env }).map(([k, v]) => `${k}=${v}`), ...inner];
    let aborted = false;
    let proc: Awaited<ReturnType<Sandbox['exec']>> & { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> };
    try {
      proc = (await sb.exec(full, { mode: 'binary', workdir: o.cwd ?? '/work', timeoutMs: o.timeoutMs + 20_000 })) as any;
    } catch (err) {
      if (isGone(err)) throw new SandboxGoneError();
      throw err;
    }
    const kill = () => {
      aborted = true;
      sb.exec(['bash', '-c', `p=$(cat ${pidFile} 2>/dev/null) && kill -KILL -- -$p 2>/dev/null; true`], {})
        .then((k) => k.wait())
        .catch((err) => log.debug({ err }, 'sandbox kill exec failed'));
    };
    if (o.signal?.aborted) kill();
    o.signal?.addEventListener('abort', kill, { once: true });
    try {
      if (o.stdin?.byteLength) {
        const w = proc.stdin.getWriter();
        await w.write(new Uint8Array(o.stdin));
        await w.close();
      } else {
        await proc.stdin.close().catch(() => {});
      }
      const [out, err] = await Promise.all([readCapped(proc.stdout, o.maxOutputBytes), readCapped(proc.stderr, o.maxOutputBytes)]);
      const code = await proc.wait();
      const durationMs = Date.now() - started;
      // timeout(1): 124 on TERM, 137 after the KILL that follows --kill-after.
      const timedOut = !aborted && (code === 124 || code === 137) && durationMs >= secs * 1000 - 500;
      return { exitCode: code, stdout: out.bytes, stderr: err.bytes, stdoutTruncated: out.truncated, stderrTruncated: err.truncated, timedOut, aborted, durationMs };
    } catch (err) {
      const durationMs = Date.now() - started;
      if (isGone(err)) throw new SandboxGoneError();
      if (/deadline exceeded/i.test(String((err as any)?.message))) {
        kill();
        return { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false, timedOut: !aborted, aborted, durationMs };
      }
      throw err;
    } finally {
      o.signal?.removeEventListener('abort', kill);
      sb.exec(['rm', '-f', pidFile], {})
        .then((p) => p.wait())
        .catch(() => {});
    }
  }

  async readFile(h: Handle, path: string, o: { maxBytes: number }): Promise<{ bytes: Buffer; size: number }> {
    const sb = await this.sandbox(h);
    try {
      const st = await sb.filesystem.stat(path);
      if (st.type !== 'file') throw new Error(`${path} is a ${st.type}, not a file`);
      if (st.size > o.maxBytes) return { bytes: Buffer.alloc(0), size: st.size };
      const bytes = Buffer.from(await sb.filesystem.readBytes(path));
      return { bytes, size: bytes.byteLength };
    } catch (err) {
      if ((err as any)?.constructor?.name === 'SandboxFilesystemNotFoundError') throw new Error(`No such file: ${path}`);
      if (isGone(err) && !/No such file/.test(String((err as any)?.message))) throw new SandboxGoneError();
      throw err;
    }
  }

  async writeFile(h: Handle, path: string, bytes: Buffer): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const r = await this.exec(h, ['bash', '-c', `mkdir -p ${shq(dir)} && cat > ${shq(path)}`], { stdin: bytes, timeoutMs: 120_000, maxOutputBytes: 4096 });
    if (r.exitCode !== 0) throw new Error(`write failed: ${r.stderr.toString('utf8').trim().slice(0, 300) || `exit ${r.exitCode}`}`);
  }

  async destroy(h: Handle): Promise<void> {
    try {
      const sb = this.#sandboxes.get(h.providerId) ?? (await this.client.sandboxes.fromId(h.providerId));
      await sb.terminate();
    } catch (err) {
      if (!isGone(err)) throw err;
    } finally {
      this.#sandboxes.get(h.providerId)?.detach?.();
      this.#sandboxes.delete(h.providerId);
    }
  }

  async deletePaused(p: Paused): Promise<void> {
    try {
      await this.client.images.delete(p.ref);
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }

  async list(tags: Record<string, string>): Promise<{ providerId: string; tags: Record<string, string> }[]> {
    const app = await this.app();
    const out: { providerId: string; tags: Record<string, string> }[] = [];
    for await (const sb of this.client.sandboxes.list({ appId: app.appId, tags, environment: env.MODAL_ENVIRONMENT })) {
      out.push({ providerId: sb.sandboxId, tags: await sb.getTags().catch(() => ({})) });
      sb.detach?.();
    }
    return out;
  }

  async isAlive(h: Handle): Promise<boolean> {
    try {
      const sb = await this.client.sandboxes.fromId(h.providerId);
      const code = await sb.poll();
      sb.detach?.();
      return code === null;
    } catch (err) {
      if (isGone(err)) return false;
      throw err;
    }
  }

  /**
   * Modal's metered cost this month (USD): this environment and the whole workspace. Raw gRPC (not part of the SDK's
   * public API, may change): any failure returns null and the estimate alone decides.
   */
  async meteredSpend(): Promise<{ environmentUsd: number | null; workspaceUsd: number | null }> {
    const cp = this.client.cpClient as any;
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    let environmentUsd: number | null = null;
    let workspaceUsd: number | null = null;
    try {
      const envs = await cp.environmentList({});
      const e = (envs.items ?? []).find((x: any) => x.name === (env.MODAL_ENVIRONMENT ?? 'main'));
      const id = e?.environmentId ?? e?.id;
      if (id) {
        const s = await cp.environmentBillingSummary({ environmentId: id, startTimestamp: start });
        const v = Number(s.meteredCost);
        if (Number.isFinite(v)) environmentUsd = v;
      }
    } catch (err) {
      log.debug({ err: String((err as any)?.message ?? err) }, 'modal environment billing summary failed');
    }
    try {
      const s = await cp.workspaceBillingSummary({ startTimestamp: start });
      const v = Number(s.meteredCost);
      if (Number.isFinite(v)) workspaceUsd = v;
    } catch (err) {
      log.debug({ err: String((err as any)?.message ?? err) }, 'modal workspace billing summary failed');
    }
    return { environmentUsd, workspaceUsd };
  }
}
