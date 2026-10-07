/**
 * In-memory SandboxProvider for integration tests (no Modal). Each sandbox is a map of files; `exec` understands
 * just enough for the tools' wrappers (the sandbox_exec script, request_preview's checks and tar), and anything else
 * goes to `onExec` (tests script it). Counts every create / resume / pause / destroy.
 */
import { writeTar } from './preview/tar.js';
import { SandboxGoneError, type ExecOptions, type ExecResult, type Handle, type Paused, type SandboxProvider, type SandboxSpec } from './provider.js';

interface FakeBox {
  id: string;
  files: Map<string, Buffer>;
  tags: Record<string, string>;
  alive: boolean;
  spec: SandboxSpec;
}

export class FakeProvider implements SandboxProvider {
  readonly name = 'fake' as const;
  boxes = new Map<string, FakeBox>();
  snapshots = new Map<string, Map<string, Buffer>>();
  counts = { create: 0, resume: 0, pause: 0, destroy: 0, deletePaused: 0, exec: 0 };
  createDelayMs = 0;
  /** A slow snapshot (the box stays listed meanwhile, as on Modal). */
  pauseDelayMs = 0;
  /** Commands of sandbox_exec (SBX_CMD) → result. Default: echo the command. */
  onExec: (cmd: string, box: FakeBox) => { exitCode?: number; stdout?: string; stderr?: string } = (cmd) => ({ stdout: `ran: ${cmd}\n` });
  private n = 0;

  async create(spec: SandboxSpec): Promise<Handle> {
    this.counts.create++;
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
    const id = `fake-${++this.n}-${Math.random().toString(36).slice(2, 6)}`;
    this.boxes.set(id, { id, files: new Map(), tags: spec.tags, alive: true, spec });
    return { providerId: id };
  }

  async resume(p: Paused, spec: SandboxSpec): Promise<Handle> {
    const snap = this.snapshots.get(p.ref);
    if (!snap) throw new Error('snapshot not found');
    this.counts.resume++;
    const h = await this.create(spec);
    this.counts.create--;
    this.boxes.get(h.providerId)!.files = new Map(snap);
    return h;
  }

  private box(h: Handle): FakeBox {
    const b = this.boxes.get(h.providerId);
    if (!b || !b.alive) throw new SandboxGoneError();
    return b;
  }

  async pause(h: Handle): Promise<Paused> {
    if (this.pauseDelayMs) await new Promise((r) => setTimeout(r, this.pauseDelayMs));
    const b = this.box(h);
    this.counts.pause++;
    const ref = `snap-${b.id}`;
    this.snapshots.set(ref, new Map(b.files));
    b.alive = false;
    return { kind: 'fs-snapshot', ref, expiresAt: new Date(Date.now() + 86_400_000) };
  }

  async exec(h: Handle, argv: string[], o: ExecOptions): Promise<ExecResult> {
    const b = this.box(h);
    this.counts.exec++;
    const started = Date.now();
    const res = (exitCode: number, stdout = '', stderr = ''): ExecResult => ({
      exitCode,
      stdout: Buffer.from(stdout).subarray(0, o.maxOutputBytes),
      stderr: Buffer.from(stderr).subarray(0, o.maxOutputBytes),
      stdoutTruncated: Buffer.byteLength(stdout) > o.maxOutputBytes,
      stderrTruncated: false,
      timedOut: false,
      aborted: !!o.signal?.aborted,
      durationMs: Date.now() - started,
    });
    const script = argv[argv.length - 1] ?? '';
    if (o.env?.SBX_CMD !== undefined) {
      const r = this.onExec(o.env.SBX_CMD, b);
      return res(r.exitCode ?? 0, r.stdout ?? '', r.stderr ?? '');
    }
    // writeFile: mkdir -p DIR && cat > FILE
    const cat = /cat > '([^']+)'$/.exec(script);
    if (cat) {
      b.files.set(cat[1]!, Buffer.from(o.stdin ?? Buffer.alloc(0)));
      return res(0);
    }
    // request_preview's check
    const cd = /^cd '([^']+)'/.exec(script);
    if (cd && script.includes('NODIR')) {
      const dir = cd[1]!.replace(/\/$/, '');
      const files = [...b.files.entries()].filter(([p]) => p.startsWith(`${dir}/`));
      if (!files.length) return res(0, 'NODIR\n');
      const total = files.reduce((s, [, d]) => s + d.length, 0);
      const max = files.reduce((m, [p, d]) => (d.length > m[0] ? ([d.length, p] as [number, string]) : m), [0, ''] as [number, string]);
      const index = b.files.has(`${dir}/index.html`) ? 'INDEX\n' : '';
      return res(0, `${index}FILES ${files.length}\nLINKS 0\nTOTAL ${total}\nMAX ${max[0]} ${max[1]}\n`);
    }
    const tar = /tar --format=gnu -cf (\S+) -C '([^']+)' \.$/.exec(script);
    if (tar) {
      const dir = tar[2]!.replace(/\/$/, '');
      const entries = [...b.files.entries()].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, d]) => ({ path: `./${p.slice(dir.length + 1)}`, data: d }));
      b.files.set(tar[1]!, writeTar(entries));
      return res(0);
    }
    return res(0);
  }

  async readFile(h: Handle, path: string, o: { maxBytes: number }): Promise<{ bytes: Buffer; size: number }> {
    const b = this.box(h);
    const d = b.files.get(path);
    if (!d) throw new Error(`No such file: ${path}`);
    if (d.length > o.maxBytes) return { bytes: Buffer.alloc(0), size: d.length };
    return { bytes: Buffer.from(d), size: d.length };
  }

  async writeFile(h: Handle, path: string, bytes: Buffer): Promise<void> {
    this.box(h).files.set(path, Buffer.from(bytes));
  }

  async destroy(h: Handle): Promise<void> {
    const b = this.boxes.get(h.providerId);
    if (b?.alive) this.counts.destroy++;
    if (b) b.alive = false;
  }

  async deletePaused(p: Paused): Promise<void> {
    if (this.snapshots.delete(p.ref)) this.counts.deletePaused++;
  }

  async list(tags: Record<string, string>): Promise<{ providerId: string; tags: Record<string, string> }[]> {
    return [...this.boxes.values()].filter((b) => b.alive && Object.entries(tags).every(([k, v]) => b.tags[k] === v)).map((b) => ({ providerId: b.id, tags: b.tags }));
  }

  async isAlive(h: Handle): Promise<boolean> {
    return !!this.boxes.get(h.providerId)?.alive;
  }

  /** Simulate a provider-side kill (lifetime). */
  kill(providerId: string) {
    const b = this.boxes.get(providerId);
    if (b) b.alive = false;
  }

  live(): FakeBox[] {
    return [...this.boxes.values()].filter((b) => b.alive);
  }
}
