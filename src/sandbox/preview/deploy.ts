/**
 * Preview deploy (docs/sandbox.md D16, §3.6 step 3): `wrangler deploy --temporary` from a FRESH sandbox built from
 * the deploy image (Node + pinned wrangler, no credentials), with a fresh HOME / XDG_CONFIG_HOME per deploy, so no
 * requester can land in another one's temporary account and the subagent's sandbox (untrusted content) never touches
 * the deploy. Wrangler's output is never logged raw: only the exit code and a redacted tail on failure.
 *
 * Output (confirmed by the Cloudflare spike, docs/sandbox.md §9):
 *  - `WRANGLER_OUTPUT_FILE_PATH` is ND-JSON: a `wrangler-session` record, then a `deploy` record
 *    `{ type, version, worker_name, worker_tag, version_id, targets, worker_name_overridden, bundle_size, timestamp }`
 *    whose `targets` holds `https://<worker>.<account-subdomain>.workers.dev`;
 *  - the temporary account is `$XDG_CONFIG_HOME/.wrangler/wrangler-temporary-account.toml` with `account.id`,
 *    `account.name`, `account.apiToken`, `account.expiresAt`, `claim.url`, `claim.expiresAt` (expiry 60 min after
 *    creation, the same for account and claim);
 *  - wrangler also prints a "Temporary account ready … Claim URL" block, so its console output only ever leaves the
 *    sandbox through `redact`.
 * Nothing here fetches the preview URL: a server-side fetch of a fresh temporary deploy got a Cloudflare challenge
 * page (403) in the spike, so reachability from the server says nothing about browsers and must not gate going live.
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

/**
 * Pure: replace anything that could be a credential or claim link before a wrangler tail goes into a log or a row:
 * every URL except a plain workers.dev one (wrangler's "Temporary account ready … Claim URL" block, whatever its
 * exact shape), `token = …`-style pairs, and long opaque strings (tokens, 32-hex account ids).
 */
export function redact(s: string): string {
  return s
    .replace(/https?:\/\/\S+/gi, (u) => (/^https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[^\s?#]*)?$/i.test(u) && !/claim|token/i.test(u) ? u : '[redacted-url]'))
    .replace(/\b(?:api[_-]?token|token|secret|key)\s*[=:]\s*\S+/gi, '[redacted]')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]');
}

/** The temporary account file wrangler writes under `$XDG_CONFIG_HOME/.wrangler/`. */
export const TEMP_ACCOUNT_FILE = 'wrangler-temporary-account.toml';

export interface DeployRecord {
  url: string;
  /** `worker_name` from the record (what wrangler actually deployed; the takedown targets it). */
  workerName: string | null;
}

/** Pure: the https target of a deploy record, preferring the workers.dev one. Targets are strings (or `{ url }`). */
function deployTarget(targets: unknown): string | null {
  if (!Array.isArray(targets)) return null;
  const urls = targets
    .map((t) => (typeof t === 'string' ? t : typeof (t as { url?: unknown })?.url === 'string' ? (t as { url: string }).url : null))
    .filter((u): u is string => !!u && /^https:\/\/[^\s/]+/i.test(u));
  return urls.find((u) => /^https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/|$)/i.test(u)) ?? urls[0] ?? null;
}

/**
 * Pure: the deploy record from wrangler's ND-JSON output file (the last `type: "deploy"` line; the `wrangler-session`
 * line and anything unparsable are skipped). Failing that, any workers.dev URL in the text, without a worker name.
 */
export function parseDeployRecord(ndjson: string): DeployRecord | null {
  let found: DeployRecord | null = null;
  for (const line of ndjson.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (j?.type !== 'deploy') continue;
      const url = deployTarget(j.targets);
      if (url) found = { url, workerName: typeof j.worker_name === 'string' && j.worker_name ? j.worker_name : null };
    } catch {}
  }
  if (found) return found;
  const m = /https:\/\/[a-z0-9.-]+\.workers\.dev\b/i.exec(ndjson);
  return m ? { url: m[0], workerName: null } : null;
}

/** Pure: the preview URL from wrangler's ND-JSON output file. */
export function parseDeployUrl(ndjson: string): string | null {
  return parseDeployRecord(ndjson)?.url ?? null;
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

/**
 * Pure: the temporary account and claim fields of `wrangler-temporary-account.toml` (parsed with parseSimpleToml):
 * exactly `account.id`, `account.apiToken`, `account.expiresAt`, `claim.url`, `claim.expiresAt`. The claim shares the
 * account's expiry, so a missing `claim.expiresAt` falls back to it. Expiries: ISO / TOML datetimes or epoch s / ms.
 */
export function pickTemporaryAccount(kv: Record<string, string>): Omit<DeployResult, 'url' | 'workerName'> {
  const get = (k: string) => (kv[k]?.trim() ? kv[k]!.trim() : null);
  const date = (v: string | null) => {
    if (!v) return null;
    const d = new Date(/^\d+$/.test(v) ? Number(v) * (v.length <= 10 ? 1000 : 1) : v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const claimUrl = get('claim.url');
  const accountExpiresAt = date(get('account.expiresAt'));
  return {
    accountId: get('account.id'),
    apiToken: get('account.apiToken'),
    accountExpiresAt,
    claimUrl: claimUrl && /^https:\/\//i.test(claimUrl) ? claimUrl : null,
    claimExpiresAt: date(get('claim.expiresAt')) ?? accountExpiresAt,
  };
}

/**
 * Pure: the shell snippet that prints wrangler's ND-JSON output, the split marker, then the temporary account file:
 * `$XDG_CONFIG_HOME/.wrangler/` first, else the first file of that name anywhere under the deploy HOME (wrangler also
 * writes a copy next to its metrics.json). Only that one file is read, never other TOML under HOME.
 */
export function readDeployOutputScript(o: { outFile: string; home: string; xdgConfigHome: string; split: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    `cat ${q(o.outFile)} 2>/dev/null`,
    `printf '%s' ${q(o.split)}`,
    `f=${q(`${o.xdgConfigHome}/.wrangler/${TEMP_ACCOUNT_FILE}`)}`,
    `[ -f "$f" ] || f=$(find ${q(o.home)} -type f -name ${q(TEMP_ACCOUNT_FILE)} -size -64k 2>/dev/null | head -n 1)`,
    `[ -n "$f" ] && head -c 65536 "$f"`,
    'exit 0',
  ].join('; ');
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
      const xdgConfigHome = `${home}/.config`;
      const outFile = '/tmp/out.ndjson';
      const run = await provider.exec(
        h,
        ['bash', '-c', 'mkdir -p /work/p "$HOME/.config" && tar -xf /work/bundle.tar -C /work/p && cd /work/p && wrangler deploy --temporary > /tmp/wrangler.log 2>&1; rc=$?; tail -c 4000 /tmp/wrangler.log; exit $rc'],
        {
          env: { HOME: home, XDG_CONFIG_HOME: xdgConfigHome, WRANGLER_OUTPUT_FILE_PATH: outFile, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
          timeoutMs: limits.previewDeployTimeoutMs,
          maxOutputBytes: 8192,
        },
      );
      if (run.exitCode !== 0) {
        const tail = redact(run.stdout.toString('utf8') + run.stderr.toString('utf8')).slice(-600);
        log.warn({ previewId: o.previewId, exitCode: run.exitCode, timedOut: run.timedOut }, 'preview deploy failed');
        throw new DeployError(`wrangler exited ${run.exitCode ?? 'without a code'}${run.timedOut ? ' (timed out)' : ''}: ${tail}`);
      }
      // Holds the account token and claim URL: parsed here, never logged.
      const out = await provider.exec(h, ['bash', '-c', readDeployOutputScript({ outFile, home, xdgConfigHome, split: SPLIT })], {
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      });
      const [ndjson = '', accountText = ''] = out.stdout.toString('utf8').split(SPLIT);
      const record = parseDeployRecord(ndjson);
      if (!record) throw new DeployError('wrangler finished but no workers.dev URL was found in its output');
      const account = pickTemporaryAccount(parseSimpleToml(accountText));
      if (!account.accountId || !account.apiToken || !account.claimUrl) {
        // Still live (and it expires on its own); only takedown / claim are lost. Field names only, no values.
        log.warn(
          { previewId: o.previewId, missing: Object.entries({ 'account.id': account.accountId, 'account.apiToken': account.apiToken, 'claim.url': account.claimUrl }).filter(([, v]) => !v).map(([k]) => k) },
          'preview deploy: temporary account file incomplete',
        );
      }
      return { url: record.url, workerName: record.workerName ?? o.workerName, ...account };
    } finally {
      await provider.destroy(h).catch((err) => log.warn({ err }, 'deploy sandbox destroy failed'));
      await closeSegments({ id: segment });
    }
  },

  /** Admin takedown with the temporary token while it's valid (200 `success: true` in the spike, before a claim). */
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
