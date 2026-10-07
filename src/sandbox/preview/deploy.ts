/**
 * Preview deploy (docs/sandbox.md D16, §3.6 step 3): `wrangler deploy --temporary` from a FRESH sandbox built from
 * the deploy image (Node + pinned wrangler, no credentials), with a fresh HOME / XDG_CONFIG_HOME per deploy, so no
 * requester can land in another one's temporary account and the subagent's sandbox (untrusted content) never touches
 * the deploy. Wrangler's output is never logged raw: only the exit code and a redacted tail on failure.
 *
 * Output parsing is defensive: the ND-JSON deploy record for the URL, and whatever temporary-account file wrangler
 * writes under the fresh HOME for `account.{id,apiToken,expiresAt}` / `claim.{url,expiresAt}` (exact file name and
 * keys to be confirmed by the Cloudflare spike, docs/sandbox.md §10).
 */
import { limits } from '../../config.js';
import { log } from '../../log.js';
import { closeSegments, openSegment } from '../budget.js';
import { egressAllowlist } from '../egress.js';
import type { SandboxSpec } from '../provider.js';
import { baseTags, sandboxProvider } from '../providers.js';
import { WORKER_SCRIPT, wranglerConfig, type BundleFile } from './bundle.js';
import { writeTar } from './tar.js';

export interface DeployResult {
  url: string;
  workerName: string;
  accountId: string | null;
  apiToken: string | null;
  accountExpiresAt: Date | null;
  claimUrl: string | null;
  claimExpiresAt: Date | null;
}

export class DeployError extends Error {}

/** Pure: replace anything that could be a credential or claim link before a wrangler tail goes into a log or a row. */
export function redact(s: string): string {
  return s
    .replace(/https?:\/\/\S*(?:claim|token)\S*/gi, '[redacted-url]')
    .replace(/\b(?:api[_-]?token|token|secret|key)\s*[=:]\s*\S+/gi, '[redacted]')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]');
}

/** Pure: the workers.dev URL from wrangler's ND-JSON output file (or, failing that, any workers.dev URL in the text). */
export function parseDeployUrl(ndjson: string): string | null {
  for (const line of ndjson.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (j?.type === 'deploy' && Array.isArray(j.targets)) {
        const u = j.targets.find((x: unknown) => typeof x === 'string' && /^https:\/\//.test(x));
        if (u) return u;
      }
    } catch {}
  }
  const m = /https:\/\/[a-z0-9.-]+\.workers\.dev\b/i.exec(ndjson);
  return m ? m[0] : null;
}

/** Pure: a flat `section.key → value` map from simple TOML (strings, numbers, booleans; dotted sections). */
export function parseSimpleToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_.\-"]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.replace(/"/g, '');
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[section ? `${section}.${key}` : key] = v;
  }
  return out;
}

/** Pure: pick the temporary account and claim fields out of the parsed file(s). */
export function pickTemporaryAccount(kv: Record<string, string>): Omit<DeployResult, 'url' | 'workerName'> {
  const find = (re: RegExp) => Object.entries(kv).find(([k]) => re.test(k))?.[1] ?? null;
  const date = (v: string | null) => {
    if (!v) return null;
    const d = new Date(/^\d+$/.test(v) ? Number(v) * (v.length <= 10 ? 1000 : 1) : v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return {
    accountId: find(/(^|\.)account(\.|_)id$|^account\.id$|(^|\.)account_id$/i),
    apiToken: find(/api_?token$|apitoken$/i) ?? find(/(^|\.)token$/i),
    accountExpiresAt: date(find(/^account\.expires_?at$|^account\.expiresat$|^expires_?at$/i)),
    claimUrl: find(/claim(\.|_)?url$/i),
    claimExpiresAt: date(find(/^claim\.expires_?at$|claim_?expires_?at$/i)),
  };
}

const SPLIT = '\n----SMASNUG-SPLIT----\n';

/** The deploy step itself (tests replace it). */
export const previewDeployer = {
  deploy: async (o: { previewId: string; workerName: string; files: BundleFile[]; withWorker: boolean; userId: string; threadId: string; wranglerVersion: string }): Promise<DeployResult> => {
    const provider = sandboxProvider();
    const spec: SandboxSpec = {
      image: { kind: 'deploy' },
      cpu: 0.25,
      cpuLimit: 1,
      memoryMiB: 512,
      memoryLimitMiB: 1024,
      lifetimeMs: 5 * 60_000,
      egress: { allowCidrs: egressAllowlist({ ipv6: false }) },
      // Only the preview id links it to anything (reconcile).
      tags: { ...baseTags(), kind: 'deploy', preview: o.previewId },
    };
    const segment = await openSegment({ previewId: o.previewId, userId: o.userId, threadId: o.threadId, cpu: spec.cpuLimit, memoryMiB: spec.memoryLimitMiB });
    const h = await provider.create(spec);
    try {
      const bundle = writeTar([
        ...o.files.map((f) => ({ path: `site/${f.path}`, data: f.data })),
        { path: 'wrangler.jsonc', data: Buffer.from(wranglerConfig({ name: o.workerName, withWorker: o.withWorker })) },
        ...(o.withWorker ? [{ path: 'worker.js', data: Buffer.from(WORKER_SCRIPT) }] : []),
      ]);
      await provider.writeFile(h, '/work/bundle.tar', bundle);
      const home = `/tmp/h-${o.previewId}`;
      const run = await provider.exec(
        h,
        ['bash', '-c', 'mkdir -p /work/p "$HOME/.config" && tar -xf /work/bundle.tar -C /work/p && cd /work/p && wrangler deploy --temporary > /tmp/wrangler.log 2>&1; rc=$?; tail -c 4000 /tmp/wrangler.log; exit $rc'],
        {
          env: { HOME: home, XDG_CONFIG_HOME: `${home}/.config`, WRANGLER_OUTPUT_FILE_PATH: '/tmp/out.ndjson', CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
          timeoutMs: limits.previewDeployTimeoutMs,
          maxOutputBytes: 8192,
        },
      );
      if (run.exitCode !== 0) {
        const tail = redact(run.stdout.toString('utf8') + run.stderr.toString('utf8')).slice(-600);
        log.warn({ previewId: o.previewId, exitCode: run.exitCode, timedOut: run.timedOut }, 'preview deploy failed');
        throw new DeployError(`wrangler exited ${run.exitCode ?? 'without a code'}${run.timedOut ? ' (timed out)' : ''}: ${tail}`);
      }
      const out = await provider.exec(
        h,
        ['bash', '-c', `cat /tmp/out.ndjson 2>/dev/null; printf '${SPLIT.replace(/\n/g, '\\n')}'; find ${home} -type f \\( -iname '*temporary*' -o -iname '*.toml' \\) -size -64k -exec cat {} \\; 2>/dev/null`],
        { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 },
      );
      const [ndjson = '', accountText = ''] = out.stdout.toString('utf8').split(SPLIT);
      const url = parseDeployUrl(ndjson);
      if (!url) throw new DeployError('wrangler finished but no workers.dev URL was found in its output');
      const account = pickTemporaryAccount(parseSimpleToml(accountText));
      return { url, workerName: o.workerName, ...account };
    } finally {
      await provider.destroy(h).catch((err) => log.warn({ err }, 'deploy sandbox destroy failed'));
      await closeSegments({ id: segment });
    }
  },

  /** Admin takedown with the temporary token while it's valid (unverified; the preview expires in < 60 min anyway). */
  takedown: async (o: { accountId: string; apiToken: string; workerName: string }): Promise<boolean> => {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(o.accountId)}/workers/scripts/${encodeURIComponent(o.workerName)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${o.apiToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
