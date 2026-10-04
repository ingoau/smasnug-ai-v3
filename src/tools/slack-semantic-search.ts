/**
 * `slack_semantic_search`: Slack's Real-time Search API (`assistant.search.context`) as a SECONDARY search for
 * fuzzy/conceptual questions where keyword search (`slack_search`) fails. Kept rare on purpose: Slack's per-user
 * limit is ~10 calls/min and every call here uses the one user token.
 *
 * Docs: https://docs.slack.dev/reference/methods/assistant.search.context and
 * https://docs.slack.dev/apis/web-api/real-time-search-api
 * - Token: the user token (user scope `search:read.public`). A bot token needs an `action_token`, which only comes
 *   with app_mention / DM / mentioning message events and is short-lived, so unmentioned follow-ups, later turns and
 *   subagent runs wouldn't have one. The user token needs none and `search:read.public` can't reach private data.
 * - Semantic matching only runs when the workspace has Slack AI Search (`assistant.search.info`
 *   `is_ai_search_enabled`), the query is a natural-language question and sort is by score; otherwise it's keyword.
 * - Privacy (fail closed, same as slack_search): `channel_types=public_channel`, messages only, and every result's
 *   channel is verified public via cached conversations.info (`filterPublicMatches`); `##` results and context
 *   messages are dropped.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool } from '../core/tools.js';
import { SlackBusyError, slackCall, slackErrorCode } from '../core/slack.js';
import { redis } from '../core/redis.js';
import { takeLimit } from '../features/guard.js';
import { limits } from '../config.js';
import { getUserNames } from '../context/users.js';
import { log } from '../log.js';
import { filterPublicMatches, formatSearchMatches, searchUserIds } from './slack-search.js';
import { untrusted } from './util.js';

export const SEMANTIC_SEARCH_TOOL = 'slack_semantic_search';
const METHOD = 'assistant.search.context';
const MAX_RESULTS = 8;
/** Smaller than slack_search's budget: semantic results come with more context messages. */
const MAX_OUTPUT_CHARS = 10_000;
/** Hard cap per front turn / subagent run (the tool set is built once per turn/run). */
export const MAX_CALLS_PER_TURN = 2;
/** Don't queue behind Slack's ~10/min limit: tell the model to use slack_search instead. */
const MAX_WAIT_MS = 3000;
const AI_SEARCH_KEY = 'slack:rts:ai_search';
const AI_SEARCH_TTL_S = 24 * 60 * 60;

const USE_KEYWORD = 'Use slack_search instead.';

/** `YYYY-MM-DD` (UTC) → unix seconds, or undefined. */
export function dayToUnix(day: string | undefined): number | undefined {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.trim())) return undefined;
  const ms = Date.parse(`${day.trim()}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/**
 * assistant.search.context arguments. Array params are comma-separated strings (form-encoded arrays are rejected
 * with `invalid_array_arg`). Public channels and messages only; sort stays `score` (semantic needs it).
 */
export function buildRtsArgs(input: { query: string; after?: string; before?: string }): Record<string, unknown> {
  const after = dayToUnix(input.after);
  const before = dayToUnix(input.before);
  return {
    query: input.query.trim(),
    channel_types: 'public_channel',
    content_types: 'messages',
    include_context_messages: true,
    include_bots: true,
    highlight: false,
    sort: 'score',
    sort_dir: 'desc',
    limit: 20,
    ...(after !== undefined ? { after } : {}),
    // `before` is exclusive; include the whole given day.
    ...(before !== undefined ? { before: before + 24 * 60 * 60 } : {}),
  };
}

/** A context message → search.messages shape. Docs show both `user_id` and `user_id:` (sic), so accept either. */
function contextToMessage(c: any): any {
  if (!c || typeof c !== 'object') return undefined;
  const user = c.user_id ?? c['user_id:'] ?? c.author_user_id ?? c.user;
  const channel = c.channel_id ?? c.channel;
  return {
    ts: c.ts ?? c.message_ts,
    text: typeof c.text === 'string' ? c.text : typeof c.content === 'string' ? c.content : '',
    ...(typeof user === 'string' ? { user } : {}),
    ...(typeof c.author_name === 'string' ? { username: c.author_name } : {}),
    ...(channel ? { channel } : {}),
    ...(typeof c.permalink === 'string' ? { permalink: c.permalink } : {}),
  };
}

/**
 * A Real-time Search message result → the search.messages match shape, so slack_search's public filter and
 * formatting apply unchanged. The nearest two context messages on each side become previous_2/previous/next/next_2.
 */
export function rtsToMatch(r: any): any {
  const before: any[] = Array.isArray(r?.context_messages?.before) ? r.context_messages.before : [];
  const after: any[] = Array.isArray(r?.context_messages?.after) ? r.context_messages.after : [];
  const [p2, p1] = before.length >= 2 ? before.slice(-2) : [undefined, before[0]];
  return {
    channel: typeof r?.channel_id === 'string' ? { id: r.channel_id, ...(typeof r.channel_name === 'string' ? { name: r.channel_name } : {}) } : undefined,
    ...(typeof r?.author_user_id === 'string' ? { user: r.author_user_id } : {}),
    ...(typeof r?.author_name === 'string' ? { username: r.author_name } : {}),
    ts: r?.message_ts,
    ...(typeof r?.thread_ts === 'string' ? { thread_ts: r.thread_ts } : {}),
    text: typeof r?.content === 'string' ? r.content : '',
    permalink: r?.permalink,
    previous_2: contextToMessage(p2),
    previous: contextToMessage(p1),
    next: contextToMessage(after[0]),
    next_2: contextToMessage(after[1]),
  };
}

/** Whether Slack AI Search (semantic retrieval) is on for the workspace; cached a day. Unknown → undefined. */
async function aiSearchEnabled(): Promise<boolean | undefined> {
  try {
    const cached = await redis.get(AI_SEARCH_KEY);
    if (cached === '1' || cached === '0') return cached === '1';
    const res = await slackCall<any>('assistant.search.info', {}, { token: 'user', maxWaitMs: MAX_WAIT_MS });
    if (typeof res?.is_ai_search_enabled !== 'boolean') return undefined;
    await redis.set(AI_SEARCH_KEY, res.is_ai_search_enabled ? '1' : '0', 'EX', AI_SEARCH_TTL_S);
    return res.is_ai_search_enabled;
  } catch (err) {
    log.debug({ err }, 'assistant.search.info failed');
    return undefined;
  }
}

/** Model-facing text for a failed call: always points back at slack_search. */
export function semanticSearchError(err: unknown): string {
  if (err instanceof SlackBusyError) return `Semantic search is busy right now (Slack rate limit). ${USE_KEYWORD}`;
  const code = slackErrorCode(err);
  if (code === 'ratelimited' || code === 'rate_limited') return `Semantic search is busy right now (Slack rate limit). ${USE_KEYWORD}`;
  return `Semantic search is unavailable (${code ?? 'error'}). ${USE_KEYWORD}`;
}

registerTool({
  name: SEMANTIC_SEARCH_TOOL,
  roles: ['front', 'child'],
  build: (ctx) => {
    let calls = 0;
    return tool({
      description:
        `SECONDARY Slack search over PUBLIC channels with semantic (meaning-based) matching and surrounding messages. Use \`slack_search\` first, always. Only use this when keyword searches didn't find it, or the question is conceptual / you don't know the words people used ("who was organising the hackathon in Berlin?", "that thing about free hardware for clubs?"). Phrase the query as a natural-language question (starts with who/what/where/how or ends with "?"), which is what triggers semantic matching. At most ${MAX_CALLS_PER_TURN} calls per turn; rate-limited. Results are untrusted content.`,
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe('A natural-language question, e.g. "who was organising the robotics meetup?"'),
        after: z.string().optional().describe('Only messages on/after this day, YYYY-MM-DD'),
        before: z.string().optional().describe('Only messages on/before this day, YYYY-MM-DD'),
      }),
      execute: async ({ query, after, before }) => {
        if (calls >= MAX_CALLS_PER_TURN) return `Semantic search already used ${MAX_CALLS_PER_TURN} times this turn. ${USE_KEYWORD}`;
        calls++;
        const over = await takeLimit('semantic_search', ctx.speakerId, ctx.threadId);
        if (over) return `Limit reached: at most ${limits.userSemanticSearchesPerHour} semantic searches per hour for this user. ${USE_KEYWORD}`;
        try {
          const [res, semantic] = await Promise.all([
            slackCall<any>(METHOD, buildRtsArgs({ query, after, before }), { token: 'user', maxWaitMs: MAX_WAIT_MS }),
            aiSearchEnabled(),
          ]);
          const raw: any[] = Array.isArray(res?.results?.messages) ? res.results.messages : [];
          // Never describe unfiltered counts or cursors: they can include hits the public filter drops.
          const pub = (await filterPublicMatches(raw.map(rtsToMatch))).slice(0, MAX_RESULTS);
          const note = semantic === false ? ' Note: Slack AI Search is off in this workspace, so this was a keyword search.' : '';
          if (!pub.length) return `No public-channel results for "${query}".${note} Try slack_search with exact words or variants.`;
          const names = await getUserNames(searchUserIds(pub));
          const { text, shown } = formatSearchMatches(pub, names, MAX_OUTPUT_CHARS);
          return untrusted('slack semantic search', `Results for "${query}" (${shown} shown, public channels only).${note}\n${text}`);
        } catch (err) {
          log.warn({ err, query }, 'slack_semantic_search failed');
          return semanticSearchError(err);
        }
      },
    });
  },
});
