/**
 * Download a Slack file's `url_private` with the bot token. This is a FILE DOWNLOAD from files.slack.com, not a Web API
 * call, so it deliberately bypasses `slackCall` (no API rate-limit tier applies). The token is only ever sent to
 * https://files.slack.com (dropped on any cross-origin redirect), and the request goes through safeFetch (SSRF
 * filtering, size/time caps). Under SLACK_FAKE any public http(s) URL is fetched without auth, so fixtures can point
 * at public test files.
 */
import { env } from '../config.js';
import { safeFetch } from '../tools/safe-fetch.js';
import { formatBytes, transferTimeoutMs } from './format.js';

const SLACK_FILES_ORIGIN = 'https://files.slack.com';
/** Images may be bigger than the store's cap: they are resized for the model and only the result is cached. */
export const MAX_IMAGE_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** A download Slack refused (HTTP 4xx, or its login page): the token can't see the file, or it is gone. */
export class SlackDownloadDeniedError extends Error {}

/**
 * Which tokens to try, in order. Files from verified-public channels seen outside the bot's conversations (public
 * reads, search) try the user token first: the bot token only reaches channels the bot is in, and for an HTML file
 * Slack's login page can't be told apart from the file. Everything else uses the bot token only.
 */
export function downloadTokens(sourcePublic: boolean, hasUserToken = Boolean(env.SLACK_USER_TOKEN)): ('bot' | 'user')[] {
  return sourcePublic && hasUserToken ? ['user', 'bot'] : ['bot'];
}

/**
 * The `/download/` form of a `files-pri` URL. Slack 302s the plain `url_private` of PDFs (and other content it renders
 * inline) to a sandboxed origin (slack-files.com/files-pri-safe/...), which the origin check below would treat as a
 * refusal; the download form serves the bytes straight from files.slack.com.
 */
export function slackDownloadUrl(urlPrivate: string): string {
  const url = new URL(urlPrivate);
  const m = /^\/files-pri\/([^/]+)\/(?!download\/)(.+)$/.exec(url.pathname);
  if (url.origin === SLACK_FILES_ORIGIN && m) url.pathname = `/files-pri/${m[1]}/download/${m[2]}`;
  return url.toString();
}

/**
 * `expectHtml`: the file itself is HTML (otherwise an HTML response is Slack's login page: auth failed).
 * `token`: which token to send ('user' only for files from verified-public channels, see downloadTokens).
 */
export async function downloadSlackFile(urlPrivate: string, maxBytes: number, expectHtml = false, token: 'bot' | 'user' = 'bot'): Promise<Buffer> {
  return (await fetchSlackFile(urlPrivate, { maxBytes, expectHtml, token })).body;
}

/**
 * Stream a Slack file into `sink` (large files, src/files/large.ts) with the same checks as downloadSlackFile; the
 * caller ends the sink. Returns the bytes written.
 */
export async function downloadSlackFileTo(
  urlPrivate: string,
  sink: NodeJS.WritableStream,
  opts: { maxBytes: number; timeoutMs: number; expectHtml?: boolean; token?: 'bot' | 'user'; signal?: AbortSignal },
): Promise<number> {
  const res = await fetchSlackFile(urlPrivate, { maxBytes: opts.maxBytes, expectHtml: opts.expectHtml ?? false, token: opts.token ?? 'bot', timeoutMs: opts.timeoutMs, sink, ...(opts.signal ? { signal: opts.signal } : {}) });
  return res.streamedBytes ?? 0;
}

async function fetchSlackFile(
  urlPrivate: string,
  o: { maxBytes: number; expectHtml: boolean; token: 'bot' | 'user'; timeoutMs?: number; sink?: NodeJS.WritableStream; signal?: AbortSignal },
) {
  const fake = process.env.SLACK_FAKE === '1';
  const url = new URL(slackDownloadUrl(urlPrivate));
  if (!fake && url.origin !== SLACK_FILES_ORIGIN) throw new Error(`refusing to download from ${url.origin}`);
  const headers: Record<string, string> = { accept: '*/*' };
  const secret = o.token === 'user' ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN;
  if (!fake && secret) headers.authorization = `Bearer ${secret}`;
  const res = await safeFetch(url.toString(), {
    maxBytes: o.maxBytes,
    // Long enough for the biggest file allowed (a fixed 30 s cut off big ones on a slow link).
    timeoutMs: o.timeoutMs ?? transferTimeoutMs(o.maxBytes),
    headers,
    authOrigin: SLACK_FILES_ORIGIN,
    // Streamed: only the file itself (the checks below, before any byte is written), never Slack's login page.
    ...(o.sink ? { sink: o.sink, sinkIf: (r: { url: string; status: number; contentType: string }) => {
            const refused = refusal(r);
            if (refused) throw refused;
            return true;
          } } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const refused = refusal(res);
  if (refused) throw refused;
  if (o.sink && !res.sunk) throw new Error(`download failed: HTTP ${res.status}`);
  if (res.truncated) throw new Error(`the file is larger than ${formatBytes(o.maxBytes)}`);
  return res;

  function refusal(r: { url: string; status: number; contentType: string }): Error | null {
    // Bounced off files.slack.com (e.g. to the login page): denied, also for an HTML file, whose body would be that page.
    if (!fake && new URL(r.url).origin !== SLACK_FILES_ORIGIN) return new SlackDownloadDeniedError(`download redirected to ${new URL(r.url).origin}`);
    if (r.status >= 400 && r.status < 500 && r.status !== 429) return new SlackDownloadDeniedError(`download failed: HTTP ${r.status}`);
    if (r.status >= 400) return new Error(`download failed: HTTP ${r.status}`);
    // Slack serves an HTML login page (200) when auth is missing/invalid.
    if (!o.expectHtml && r.contentType.includes('text/html')) return new SlackDownloadDeniedError('download returned HTML (missing files:read scope or bad token?)');
    return null;
  }
}
