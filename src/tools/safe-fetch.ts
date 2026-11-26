/**
 * SSRF-safe HTTP(S) GET. Never reaches local/private addresses:
 * - http/https only, no credentials in URLs;
 * - cheap pre-check of literal hosts (localhost, IP literals in non-unicast ranges) for clear error messages;
 * - the authoritative check is connection-level via `request-filtering-agent`: the hostname is resolved by the
 *   agent's lookup, every resolved address is checked, and the socket connects to that checked address — so DNS
 *   rebinding can't swap in a private IP between check and connect. Denied: loopback, 10/8, 172.16/12,
 *   192.168/16, 169.254/16, 100.64/10, 0.0.0.0, ::1, fc00::/7, fe80::/10, IPv4-mapped/translated IPv6 and every
 *   other non-unicast range known to ipaddr.js;
 * - redirects are followed manually (max 5) and each hop goes through the same checks;
 * - byte cap on the (decompressed) body and an overall deadline.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent';

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Headers only sent to this exact origin (e.g. Slack auth for file downloads); dropped on cross-origin redirects. */
  authOrigin?: string;
  /** With authOrigin: more header names (lower-case) to drop off that origin, besides authorization (vault credentials). */
  authHeaders?: string[];
  /** Default GET. A request with a body never follows redirects (BlockedUrlError); one without: redirectMethod. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  body?: Buffer;
  signal?: AbortSignal;
  /**
   * Stream the body here instead of buffering it (big downloads, src/files/large.ts): `body` comes back empty and
   * `streamedBytes` says how much was written (still capped at maxBytes; `truncated` as usual). Backpressure is
   * respected; the caller ends the sink. A sink error aborts the request and rejects with that error. Only a 2xx
   * response (that `sinkIf` accepts) goes to the sink; any other is buffered instead, at most SINK_SKIPPED_MAX_BYTES
   * (`sunk` false), so an error page is never written out in full.
   */
  sink?: NodeJS.WritableStream;
  /**
   * With `sink`: checked once the final response's headers are in, before any body byte is read. false → buffer the
   * (short) body instead of sinking it; a throw aborts the request with that error.
   */
  sinkIf?: (res: { status: number; url: string; contentType: string; headers: http.IncomingHttpHeaders }) => boolean | Promise<boolean>;
  /** @internal tests only: custom DNS resolution (the agent still validates whatever it returns). */
  lookup?: LookupFunction;
  /** @internal tests only: exact IPs/CIDRs exempt from filtering (e.g. a 127.0.0.1 test server). */
  allowIPAddressList?: string[];
}

export interface SafeFetchResult {
  status: number;
  /** Final URL after redirects. */
  url: string;
  contentType: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Body was cut at maxBytes. */
  truncated: boolean;
  /** With `sink`: bytes written to it. */
  streamedBytes?: number;
  /** With `sink`: whether the body went to it (false: an error response, in `body`, ≤ SINK_SKIPPED_MAX_BYTES). */
  sunk?: boolean;
}

/** With a sink, the most of a response that isn't sunk (an error status or page) that is kept. */
export const SINK_SKIPPED_MAX_BYTES = 64 * 1024;

// The agents deny every address ipaddr.js doesn't classify as 'unicast' — that covers loopback, private, link-local,
// CGNAT, unspecified, ULA, IPv4-mapped etc. (A mixed v4/v6 denyIPAddressList only produces warnings, so none is set.)
const defaultAgents = {
  http: new RequestFilteringHttpAgent(),
  https: new RequestFilteringHttpsAgent(),
};

function agentsFor(allow?: string[]) {
  if (!allow?.length) return defaultAgents;
  return {
    http: new RequestFilteringHttpAgent({ allowIPAddressList: allow }),
    https: new RequestFilteringHttpsAgent({ allowIPAddressList: allow }),
  };
}

/** True if an IP literal is somewhere we must never connect to. */
export function isBlockedIp(ip: string, allow: string[] = []): boolean {
  if (allow.includes(ip)) return false;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true;
  }
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) return true;
  return addr.range() !== 'unicast';
}

/** Pre-flight URL validation (throws BlockedUrlError). Hostnames that need DNS are checked at connect time. */
export function checkUrl(raw: string, allow: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`invalid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrlError(`only http and https URLs are allowed (got ${url.protocol})`);
  if (url.username || url.password) throw new BlockedUrlError('URLs with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new BlockedUrlError('URL has no host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new BlockedUrlError(`local hostnames are not allowed (${host})`);
  }
  if (net.isIP(host) && isBlockedIp(host, allow)) throw new BlockedUrlError(`address ${host} is private/local and not allowed`);
  return url;
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const agents = agentsFor(opts.allowIPAddressList);
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let current = rawUrl;
  let method = opts.method ?? 'GET';
  for (let hop = 0; ; hop++) {
    const url = checkUrl(current, opts.allowIPAddressList);
    const res = await requestOnce(url, method === (opts.method ?? 'GET') ? opts : { ...opts, method }, agents, signal);
    if (res.redirect) {
      if (opts.body) throw new BlockedUrlError('the server redirected a request that has a body; not following it');
      if (hop >= maxRedirects) throw new BlockedUrlError(`too many redirects (>${maxRedirects})`);
      method = redirectMethod(method, res.status ?? 0);
      current = new URL(res.redirect, url).toString();
      continue;
    }
    return res.result!;
  }
}

/**
 * The method to follow a redirect with (a request without a body; one with a body never follows). GET/HEAD keep theirs.
 * Like browsers, a 303 (any method) and a 301/302 after a POST continue as GET; any other non-GET redirect (a
 * PUT/PATCH/DELETE on 301/302, or anything on 307/308, which require the same method) is refused rather than replayed
 * against another URL.
 */
export function redirectMethod(method: NonNullable<SafeFetchOptions['method']>, status: number): 'GET' | 'HEAD' {
  if (method === 'GET' || method === 'HEAD') return method;
  if (status === 303 || (method === 'POST' && (status === 301 || status === 302))) return 'GET';
  throw new BlockedUrlError(`the server redirected a ${method} request (HTTP ${status}); not repeating it at another address`);
}

function requestOnce(
  url: URL,
  opts: SafeFetchOptions,
  agents: { http: http.Agent; https: https.Agent },
  signal: AbortSignal,
): Promise<{ redirect?: string; status?: number; result?: SafeFetchResult }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const headers: Record<string, string> = {
      'user-agent': 'Mozilla/5.0 (compatible; SmasnugBot/1.0; +https://hackclub.com)',
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.9,*/*;q=0.5',
      'accept-encoding': 'gzip, deflate, br',
      ...(opts.headers ?? {}),
    };
    if (opts.authOrigin && url.origin !== opts.authOrigin) {
      delete headers.authorization;
      for (const h of opts.authHeaders ?? []) delete headers[h];
    }
    const req = (isHttps ? https : http).request(
      url,
      {
        method: opts.method ?? 'GET',
        headers,
        agent: isHttps ? agents.https : agents.http,
        signal,
        ...(opts.lookup ? { lookup: opts.lookup } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ redirect: res.headers.location, status });
          return;
        }
        const contentType = String(res.headers['content-type'] ?? '');
        res.on('error', (err) => reject(err));
        if (!opts.sink) return void readBody(null, opts.maxBytes);
        // Nothing is read until the response has been checked: an error page never reaches the sink.
        res.pause();
        const ok = status >= 200 && status < 300;
        new Promise<boolean>((r) => r(ok && (opts.sinkIf ? opts.sinkIf({ status, url: url.toString(), contentType, headers: res.headers }) : true))).then(
          (sinkIt) => (sinkIt ? readBody(opts.sink!, opts.maxBytes) : readBody(null, Math.min(opts.maxBytes, SINK_SKIPPED_MAX_BYTES))),
          (err) => {
            res.destroy();
            reject(err);
          },
        );

        function readBody(sink: NodeJS.WritableStream | null, maxBytes: number) {
          let stream: NodeJS.ReadableStream = res;
          const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
          if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          let done = false;
          const onSinkError = (err: unknown) => {
            if (done) return;
            done = true;
            res.destroy();
            reject(err);
          };
          sink?.on('error', onSinkError);
          const finish = () => {
            if (done) return;
            done = true;
            sink?.removeListener('error', onSinkError);
            resolve({
              result: {
                status,
                url: url.toString(),
                contentType,
                headers: res.headers,
                body: Buffer.concat(chunks),
                truncated,
                ...(opts.sink ? { streamedBytes: sink ? size : 0, sunk: Boolean(sink) } : {}),
              },
            });
          };
          const fail = (err: unknown) => {
            if (done) return;
            done = true;
            sink?.removeListener('error', onSinkError);
            reject(err);
          };
          const keep = (chunk: Buffer) => {
            if (!sink) return chunks.push(chunk);
            if (!sink.write(chunk)) {
              stream.pause();
              sink.once('drain', () => stream.resume());
            }
          };
          stream.on('data', (chunk: Buffer) => {
            if (done) return;
            const room = maxBytes - size;
            if (chunk.length >= room) {
              keep(chunk.subarray(0, room));
              size += room;
              truncated = true;
              finish();
              res.destroy();
              return;
            }
            keep(chunk);
            size += chunk.length;
          });
          stream.on('end', finish);
          stream.on('error', fail);
          res.resume();
        }
      },
    );
    req.on('error', (err) => reject(classify(err)));
    req.end(opts.body);
  });
}

function classify(err: any): Error {
  const msg = String(err?.message ?? err);
  if (/is not allowed\. Because/.test(msg)) return new BlockedUrlError(msg.replace(/^DNS lookup /, 'resolved address '));
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return new Error('request timed out');
  return err instanceof Error ? err : new Error(msg);
}
