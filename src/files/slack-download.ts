/**
 * Download a Slack file's `url_private` with the bot token. This is a FILE DOWNLOAD from files.slack.com, not a Web API
 * call, so it deliberately bypasses `slackCall` (no API rate-limit tier applies). The token is only ever sent to
 * https://files.slack.com (dropped on any cross-origin redirect), and the request goes through safeFetch (SSRF
 * filtering, size/time caps). Under SLACK_FAKE any public http(s) URL is fetched without auth, so fixtures can point
 * at public test files.
 */
import { env } from '../config.js';
import { safeFetch } from '../tools/safe-fetch.js';
import { formatBytes } from './format.js';

const SLACK_FILES_ORIGIN = 'https://files.slack.com';
/** Images may be bigger than the store's cap: they are resized for the model and only the result is cached. */
export const MAX_IMAGE_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** `expectHtml`: the file itself is HTML (otherwise an HTML response is Slack's login page: auth failed). */
export async function downloadSlackFile(urlPrivate: string, maxBytes: number, expectHtml = false): Promise<Buffer> {
  const fake = process.env.SLACK_FAKE === '1';
  const url = new URL(urlPrivate);
  if (!fake && url.origin !== SLACK_FILES_ORIGIN) throw new Error(`refusing to download from ${url.origin}`);
  const headers: Record<string, string> = { accept: '*/*' };
  if (!fake && env.SLACK_BOT_TOKEN) headers.authorization = `Bearer ${env.SLACK_BOT_TOKEN}`;
  const res = await safeFetch(url.toString(), { maxBytes, timeoutMs: 30_000, headers, authOrigin: SLACK_FILES_ORIGIN });
  if (res.status >= 400) throw new Error(`download failed: HTTP ${res.status}`);
  if (res.truncated) throw new Error(`the file is larger than ${formatBytes(maxBytes)}`);
  // Slack serves an HTML login page (200) when auth is missing/invalid.
  if (!expectHtml && res.contentType.includes('text/html')) throw new Error('download returned HTML (missing files:read scope or bad token?)');
  return res.body;
}
