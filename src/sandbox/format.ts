/**
 * Pure helpers for the sandbox tools (unit-tested in format.test.ts): the exec wrapper script, cutting long output to
 * head + tail, and the text the model gets.
 */
import { limits } from '../config.js';

/** Bytes of each stream the wrapper sends back in full; longer streams come as head + marker + tail. */
export const WRAP_FULL_BYTES = 48 * 1024;
export const WRAP_HEAD_BYTES = 8 * 1024;
export const WRAP_TAIL_BYTES = 32 * 1024;
const CUT_RE = /\n\u0000SBXCUT (\d+)\u0000\n/;

/**
 * The script every sandbox_exec runs (argv: bash -c SCRIPT; the command and timeout come in env vars, so nothing
 * needs quoting). Full output lands in /work/.last/{stdout,stderr}; what comes back is capped.
 */
export const EXEC_SCRIPT = `mkdir -p /work/.last
timeout --kill-after=5 "\${SBX_TIMEOUT}s" bash -c "$SBX_CMD" >/work/.last/stdout 2>/work/.last/stderr </dev/null
rc=$?
emit() { n=$(stat -c %s "$1"); if [ "$n" -le ${WRAP_FULL_BYTES} ]; then cat "$1"; else head -c ${WRAP_HEAD_BYTES} "$1"; printf '\\n\\0SBXCUT %s\\0\\n' "$n"; tail -c ${WRAP_TAIL_BYTES} "$1"; fi; }
emit /work/.last/stdout
emit /work/.last/stderr >&2
exit $rc`;

export interface StreamParts {
  head: string;
  /** Total size of the stream in bytes when it was cut, else null. */
  totalBytes: number | null;
  tail: string;
}

/** Split what the wrapper sent back into head / tail (decoded leniently as UTF-8). */
export function splitWrapped(buf: Buffer): StreamParts {
  const text = buf.toString('utf8');
  const m = CUT_RE.exec(text);
  if (!m) return { head: text, totalBytes: null, tail: '' };
  return { head: text.slice(0, m.index), totalBytes: Number(m[1]), tail: text.slice(m.index + m[0].length) };
}

/** What the model sees of one stream: head ≤ headChars + a cut note + tail ≤ tailChars. */
export function showStream(name: 'stdout' | 'stderr', p: StreamParts, headChars: number = limits.sandboxExecShowHeadChars, tailChars: number = limits.sandboxExecShowTailChars): string {
  const whole = p.totalBytes == null ? p.head : null;
  if (whole != null && whole.length <= headChars + tailChars) return whole;
  const head = (whole ?? p.head).slice(0, headChars);
  const tail = whole != null ? whole.slice(-tailChars) : p.tail.slice(-tailChars);
  const total = p.totalBytes ?? Buffer.byteLength(whole ?? '');
  const shown = Buffer.byteLength(head) + Buffer.byteLength(tail);
  return `${head}\n[… ${Math.max(0, total - shown)} bytes cut; full output in /work/.last/${name}]\n${tail}`;
}

export function formatExecResult(r: { exitCode: number | null; timedOut: boolean; aborted: boolean; durationMs: number; stdout: Buffer; stderr: Buffer; timeoutS: number }): string {
  const status = r.aborted
    ? 'stopped (run cancelled or timed out)'
    : r.timedOut
      ? `timed out after ${r.timeoutS}s (killed)`
      : `exit code ${r.exitCode ?? 'unknown'}`;
  const out = showStream('stdout', splitWrapped(r.stdout));
  const err = showStream('stderr', splitWrapped(r.stderr));
  const parts = [`${status}, ${(r.durationMs / 1000).toFixed(1)}s`];
  parts.push(out.trim() ? `stdout:\n${out}` : 'stdout: (empty)');
  if (err.trim()) parts.push(`stderr:\n${err}`);
  return parts.join('\n');
}

/** A safe file name for /work/in/ (no directories, no leading dots, no control characters). */
export function safeBaseName(raw: string, fallback = 'file'): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+/, '')
    .replace(/[^\w.\- ()+,@]/g, '_')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

/** Image types sandbox_read_file shows as an image. */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}
