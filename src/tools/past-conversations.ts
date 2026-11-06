/**
 * search_past_conversations: the speaker's earlier conversations with the bot (threads where they started a turn),
 * from the bot's stored copies (so retention, deletions and `##` hiding already apply). Which threads may be shown
 * depends on where the search runs (`decidePastThread`), so a DM or private channel never surfaces in a public one.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool, type ToolContext } from '../core/tools.js';
import type { StoredMessage } from '../core/types.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { getConversationInfo, isChannelMember, type ConversationInfo } from '../context/conversation.js';
import { formatMessages } from '../context/format.js';
import { fromStored } from '../context/normalize.js';
import { formatEnvFor } from '../context/thread.js';
import { isHiddenMessage } from '../pipeline/guidelines.js';
import { orTsQuery } from '../features/memory/store.js';
import { publicChannelIds } from './slack-search.js';
import { untrusted } from './util.js';
import { decidePastThread, type SourceKind } from './past-conversations-access.js';

export const SEARCH_PAST_CONVERSATIONS = 'search_past_conversations';

const CANDIDATE_THREADS = 15;
const THREADS_SHOWN = 5;
const MESSAGES_PER_THREAD = 4;
const RESULT_CHARS = 9000;

function threadDate(ts: string) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}

interface Candidate {
  threadId: string;
  channelId: string;
  threadTs: string;
  isDm: boolean;
  hitTs: string[];
}

async function findCandidates(speakerId: string, currentThreadId: string, tsquery: string): Promise<Candidate[]> {
  if (!tsquery) {
    // No query: the most recent conversations.
    return sql<Candidate[]>`
      select t.id as thread_id, t.channel_id, t.thread_ts, t.is_dm, array[]::text[] as hit_ts
      from threads t
      where t.id <> ${currentThreadId}
        and exists (select 1 from turns u where u.thread_id = t.id and u.author_id = ${speakerId} and u.kind = 'user')
      order by t.last_activity_at desc limit ${CANDIDATE_THREADS}`;
  }
  return sql<Candidate[]>`
    with mine as (
      select distinct u.thread_id from turns u
      where u.author_id = ${speakerId} and u.kind = 'user' and u.thread_id <> ${currentThreadId}),
    hits as (
      select m.thread_id, m.ts, ts_rank(to_tsvector('english', m.text), q) as rank
      from messages m, to_tsquery('english', ${tsquery}) q
      where m.thread_id in (select thread_id from mine) and not m.deleted and m.text <> ''
        and to_tsvector('english', m.text) @@ q)
    select h.thread_id, t.channel_id, t.thread_ts, t.is_dm,
      (array_agg(h.ts order by h.rank desc))[1:${MESSAGES_PER_THREAD}] as hit_ts
    from hits h join threads t on t.id = h.thread_id
    group by h.thread_id, t.channel_id, t.thread_ts, t.is_dm
    order by max(h.rank) desc, max(h.ts) desc
    limit ${CANDIDATE_THREADS}`;
}

/** The candidates this search may show, in order, with a label for where each one is. */
async function visibleCandidates(ctx: ToolContext, candidates: Candidate[]) {
  const hereInfo = await getConversationInfo(ctx.channelId).catch(() => null);
  const here = { channelId: ctx.channelId, kind: (hereInfo?.kind ?? 'unknown') as SourceKind, imUserId: hereInfo?.imUserId };
  const infos = new Map<string, ConversationInfo | null>();
  for (const id of new Set(candidates.filter((c) => !c.isDm && c.channelId !== ctx.channelId).map((c) => c.channelId))) {
    infos.set(id, await getConversationInfo(id).catch(() => null));
  }
  const decisions = candidates.map((c) => {
    const kind: SourceKind = c.isDm ? 'dm' : (infos.get(c.channelId)?.kind ?? 'unknown');
    return { c, kind, decision: decidePastThread({ channelId: c.channelId, kind }, here, ctx.speakerId) };
  });
  const needPublic = [...new Set(decisions.filter((d) => d.decision === 'needs_public').map((d) => d.c.channelId))];
  const publicIds = needPublic.length ? await publicChannelIds(needPublic).catch(() => new Set<string>()) : new Set<string>();
  const memberOf = new Map<string, boolean>();
  for (const id of new Set(decisions.filter((d) => d.decision === 'needs_member').map((d) => d.c.channelId))) {
    memberOf.set(id, await isChannelMember(id, ctx.speakerId));
  }
  const shown = decisions.filter(({ c, decision }) =>
    decision === 'allow' ? true : decision === 'needs_public' ? publicIds.has(c.channelId) : decision === 'needs_member' ? memberOf.get(c.channelId) === true : false,
  );
  const where = (c: Candidate, kind: SourceKind) => {
    if (c.channelId === ctx.channelId) return kind === 'dm' ? 'this DM' : 'this channel';
    const name = infos.get(c.channelId)?.name;
    if (kind === 'public_channel' || kind === 'unknown') return name ? `#${name} (public)` : 'a public channel';
    return name ? `#${name} (private)` : kind === 'group_dm' ? 'a group DM' : 'a private channel';
  };
    // ask_thread opens public and private-channel links, never DM / group DM ones (resolveLinkAccess).
  const openable = (kind: SourceKind) => kind === 'public_channel' || kind === 'private_channel' || kind === 'unknown';
  return { shown: shown.map(({ c, kind }) => ({ c, where: where(c, kind), openable: openable(kind) })), hidden: decisions.length - shown.length };
}

export function searchPastConversationsTool(ctx: ToolContext) {
  return tool({
    description:
      "Search the speaker's earlier conversations with you (other threads where they talked to you, from the last ~30 days). " +
      'Use it when they refer back to something ("last time", "the emoji you made me", "what did I say about…") instead of guessing. ' +
      'Returns the best-matching threads with their matching messages and where they were; threads from private conversations ' +
      'only show where that is safe, so a missing result is not proof it never happened. To read more of one, pass its link (when it ' +
      'has one) to ask_thread.',
    inputSchema: z.object({
      query: z
        .string()
        .max(200)
        .nullable()
        .describe('Words to look for (topics, names, emoji or project names). null lists the most recent conversations.'),
    }),
    execute: async ({ query }) => {
      const tsquery = orTsQuery([query ?? '']);
      const candidates = await findCandidates(ctx.speakerId, ctx.threadId, tsquery);
      if (!candidates.length) return query ? 'No earlier conversation with the speaker matches.' : 'No earlier conversations with the speaker are stored.';
      const { shown, hidden } = await visibleCandidates(ctx, candidates);
      log.info({ threadId: ctx.threadId, candidates: candidates.length, shown: shown.length, hidden }, 'past conversation search');
      // Withheld threads are never mentioned: "there are private matches" would itself reveal private content.
      if (!shown.length) return query ? 'No earlier conversation with the speaker matches.' : 'No earlier conversations with the speaker are stored.';

      const picked = shown.slice(0, THREADS_SHOWN);
      const channels = [...new Set(picked.map(({ c }) => c.channelId))];
      const tss = [...new Set(picked.flatMap(({ c }) => [c.threadTs, ...c.hitTs]))];
      // Over-fetches across channel × ts pairs; the per-thread filter below keeps only the wanted messages.
      const rows = await sql<StoredMessage[]>`
        select * from messages where not deleted and text <> '' and channel_id = any(${channels}) and ts = any(${tss})`;
      const budget = Math.floor(RESULT_CHARS / picked.length);
      const sections: string[] = [];
      for (const { c, where, openable } of picked) {
        const want = new Set([c.threadTs, ...(query ? c.hitTs : [])]);
        const msgs = rows
          .filter((r) => r.channelId === c.channelId && want.has(r.ts) && !isHiddenMessage(r.text))
          // Files stay out: they would otherwise be registered (and readable) in the current thread.
          .map((r) => ({ ...fromStored(r), files: [] }));
        if (!msgs.length) continue;
        const env = await formatEnvFor(ctx.threadId, msgs, budget);
        const link = `https://slack.com/archives/${c.channelId}/p${c.threadTs.replace('.', '')}`;
        const header = `### ${where}, started ${threadDate(c.threadTs)}${openable ? `: ${link}` : ''}`;
        sections.push(`${header}\n${formatMessages(msgs, env)}`);
      }
      if (!sections.length) return 'No earlier conversation with the speaker matches.';
      const more = shown.length > picked.length ? `\n\n(${shown.length - picked.length} more matching threads not shown; narrow the query.)` : '';
            return untrusted('past conversations', `${sections.join('\n\n')}${more}`);
    },
  });
}

registerTool({ name: SEARCH_PAST_CONVERSATIONS, roles: ['front'], build: searchPastConversationsTool });
