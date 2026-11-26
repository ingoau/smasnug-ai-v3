/**
 * Origin-pinned egress for MCP connectors (docs/mcp-custom-connectors.md, "Shared-process controls"). The MCP client
 * and the OAuth helper get this `fetch` instead of the global one:
 * - only the definition URL's origin (plus, for OAuth, the authorization-server origins recorded while connecting;
 *   any public https origin while connecting) — everything else throws;
 * - every request goes through safeFetch (SSRF-safe: private/local addresses refused at connect time), with no
 *   redirects followed, a byte cap and a deadline;
 * - the long-lived server-to-client SSE stream (GET with Accept: text/event-stream) is answered 405 locally: we only
 *   make request/response calls.
 */
import { BlockedUrlError, safeFetch } from '../../tools/safe-fetch.js';
import { egressAllowed, type EgressPolicy } from './logic.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** @internal tests only: IPs exempt from the private-address block (an in-process 127.0.0.1 MCP server). */
let testAllowIps: string[] = [];
export function __setConnectorTestAllowIps(ips: string[]): void {
  testAllowIps = ips;
}

export function pinnedFetch(policy: EgressPolicy, o: { signal?: AbortSignal; timeoutMs: number }): typeof fetch {
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (!egressAllowed(url, policy)) throw new BlockedUrlError(`connector request to ${url.origin} blocked (only ${policy.mcpOrigin} is allowed)`);
    const method = req.method.toUpperCase();
    if (!METHODS.has(method)) throw new BlockedUrlError(`method ${method} not allowed`);
    if (method === 'GET' && (req.headers.get('accept') ?? '').includes('text/event-stream')) return new Response(null, { status: 405 });
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
    const signals = [req.signal, ...(o.signal ? [o.signal] : [])];
    const res = await safeFetch(url.toString(), {
      method: method as 'GET',
      headers,
      ...(body && body.length ? { body } : {}),
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      timeoutMs: o.timeoutMs,
      signal: AbortSignal.any(signals),
      ...(testAllowIps.length ? { allowIPAddressList: testAllowIps } : {}),
    });
    if (res.truncated) throw new Error(`connector response over ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`);
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined || k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') continue;
      for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
    }
    const noBody = res.status === 204 || res.status === 304 || method === 'HEAD';
    return new Response(noBody ? null : new Uint8Array(res.body), { status: res.status, headers: out });
  };
  return fn as typeof fetch;
}
