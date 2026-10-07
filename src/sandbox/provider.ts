/**
 * The sandbox provider seam (docs/sandbox.md §3.2). Everything above it (lifecycle, tools, previews) is
 * provider-agnostic; swapping to E2B means writing one more implementation. No provider SDK is imported here.
 * The model never sees provider ids.
 */

export type ImageRef =
  /** The pinned work image (Python, Node, Playwright + Chromium; src/sandbox/image.ts). */
  | { kind: 'work' }
  /** The pinned preview-deploy image (Node + wrangler). */
  | { kind: 'deploy' };

export interface SandboxSpec {
  image: ImageRef;
  /** Reserved cores / hard limit. */
  cpu: number;
  cpuLimit: number;
  memoryMiB: number;
  memoryLimitMiB: number;
  /** Provider-side hard kill (Modal `timeout`). */
  lifetimeMs: number;
  /** Outbound IPv4 CIDR allowlist (egress.ts). */
  egress: { allowCidrs: string[] };
  tags: Record<string, string>;
}

export interface Handle {
  providerId: string;
}

export interface Paused {
  kind: 'fs-snapshot' | 'native';
  ref: string;
  expiresAt: Date | null;
}

export interface ExecOptions {
  /** Default /work. */
  cwd?: string;
  /** Added to the minimal sandbox env (PATH, HOME=/work, LANG, TZ). Nothing from the worker's env is passed. */
  env?: Record<string, string>;
  timeoutMs: number;
  /** Per stream (stdout / stderr); the rest is dropped and marked truncated. */
  maxOutputBytes: number;
  stdin?: Buffer;
  signal?: AbortSignal;
  /** Run as root (setup steps only); default: the unprivileged `sandbox` user. */
  root?: boolean;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  /** Stopped through `signal` (cancel / run timeout). */
  aborted: boolean;
  durationMs: number;
}

export interface SandboxProvider {
  readonly name: 'modal' | 'e2b' | 'fake';
  create(spec: SandboxSpec): Promise<Handle>;
  /** Create a sandbox from a pause (Modal: from the snapshot image). Throws when the pause can't be restored. */
  resume(paused: Paused, spec: SandboxSpec): Promise<Handle>;
  /** Snapshot the filesystem and terminate (Modal has no native pause). */
  pause(h: Handle): Promise<Paused>;
  /** argv runs as given (callers wrap shell commands as ['bash', '-lc', cmd]). */
  exec(h: Handle, argv: string[], o: ExecOptions): Promise<ExecResult>;
  readFile(h: Handle, path: string, o: { maxBytes: number }): Promise<{ bytes: Buffer; size: number }>;
  /** Parent directories are created; the file is owned by the `sandbox` user. */
  writeFile(h: Handle, path: string, bytes: Buffer): Promise<void>;
  /** Terminate; idempotent (an already-gone sandbox is fine). */
  destroy(h: Handle): Promise<void>;
  deletePaused?(p: Paused): Promise<void>;
  /** Live sandboxes carrying all of `tags` (reconcile / orphan sweep). */
  list(tags: Record<string, string>): Promise<{ providerId: string; tags: Record<string, string> }[]>;
  /** False when the provider no longer runs it (exited, killed at its lifetime, unknown). */
  isAlive(h: Handle): Promise<boolean>;
}

/** The sandbox is gone on the provider side (lifetime kill, crash): the caller treats the row as lost. */
export class SandboxGoneError extends Error {
  constructor(message = 'The sandbox is no longer running.') {
    super(message);
    this.name = 'SandboxGoneError';
  }
}

/** A path inside the sandbox that tools may touch: absolute or relative to /work, normalised, under /work. */
export function workPath(p: string): string | null {
  const raw = (p ?? '').trim();
  if (!raw || raw.includes('\0')) return null;
  const abs = raw.startsWith('/') ? raw : `/work/${raw}`;
  const out: string[] = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out[0] !== 'work') return null;
  return '/' + out.join('/');
}

/** Quote one argument for bash. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
