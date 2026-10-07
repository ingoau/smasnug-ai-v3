/**
 * Directory queries for find_people / find_channels: trigram similarity (pg_trgm word_similarity) plus ILIKE, ranked
 * exact > prefix > substring > fuzzy. People match ONLY handle, display name, real name and title; pronouns, status,
 * tz and the other display-only fields are never part of a query. Channels: name matches rank above topic / purpose.
 */
import { sql } from '../../db/index.js';
import type { PersonRow, ChannelRow } from './store.js';

export const MAX_RESULTS = 10;

/** The query as typed, normalised: one line, trimmed, a leading @ / # and Slack mention wrappers removed, capped. */
export function normalizeQuery(q: string): string {
  return q
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/^\s*<[@#]([A-Z0-9]+)(?:\|[^>]*)?>\s*$/, '$1')
    .replace(/^\s*[@#]/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/** ILIKE pattern for a substring, with %, _ and \ escaped. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** A channel-name form of the query: lowercase, spaces / underscores → hyphens ("hack night" → "hack-night"). */
export function channelNameForm(q: string): string {
  return q.toLowerCase().replace(/[\s_]+/g, '-');
}

export type PersonKind = 'any' | 'person' | 'bot';

/** Ranked people for a query. A user id (U…/W…, or a mention) matches that person. */
export async function searchPeople(query: string, opts: { kind?: PersonKind; includeDeactivated?: boolean; limit?: number } = {}): Promise<PersonRow[]> {
  const q = normalizeQuery(query);
  if (!q) return [];
  const limit = Math.max(1, Math.min(MAX_RESULTS, opts.limit ?? MAX_RESULTS));
  const kind = opts.kind ?? 'any';
  const incl = Boolean(opts.includeDeactivated);
  if (/^[UW][A-Z0-9]{2,}$/.test(q)) {
    const byId = await sql<PersonRow[]>`select * from directory_people where id = ${q} and (${incl} or not deleted)`;
    if (byId.length) return byId;
  }
  const pat = `%${likeEscape(q)}%`;
  const pre = `${likeEscape(q)}%`;
  // Per searchable column: 3 exact, 2+ prefix, 1+ substring, else word similarity (0–1). Title counts 70 %.
  return sql<PersonRow[]>`
    with m as (
      select p.*, greatest(
        case when lower(handle) = lower(${q}) then 3 when handle ilike ${pre} then 2 + similarity(handle, ${q}) when handle ilike ${pat} then 1 + similarity(handle, ${q}) else word_similarity(${q}, handle) end,
        case when lower(display_name) = lower(${q}) then 3 when display_name ilike ${pre} then 2 + similarity(display_name, ${q}) when display_name ilike ${pat} then 1 + similarity(display_name, ${q}) else word_similarity(${q}, display_name) end,
        case when lower(real_name) = lower(${q}) then 3 when real_name ilike ${pre} then 2 + similarity(real_name, ${q}) when real_name ilike ${pat} then 1 + similarity(real_name, ${q}) else word_similarity(${q}, real_name) end,
        0.7 * (case when lower(title) = lower(${q}) then 3 when title ilike ${pat} then 1 + similarity(title, ${q}) else word_similarity(${q}, title) end)
      ) as score
      from directory_people p
      -- Candidates via the one trigram index over the searchable fields (search_text, migration 270).
      where (lower(${q}) <% search_text or search_text ilike ${pat})
        and (${incl} or not deleted)
        and (${kind} = 'any' or (${kind} = 'bot') = (is_bot or is_app_user))
    )
    select * from m order by score - (case when deleted then 0.05 else 0 end) desc, length(coalesce(nullif(display_name, ''), real_name, handle)), id
    limit ${limit}`;
}

/** Ranked public channels for a query (archived included unless `includeArchived` is false). */
export async function searchChannels(query: string, opts: { includeArchived?: boolean; limit?: number } = {}): Promise<ChannelRow[]> {
  const q = normalizeQuery(query);
  if (!q) return [];
  const limit = Math.max(1, Math.min(MAX_RESULTS, opts.limit ?? MAX_RESULTS));
  const incl = opts.includeArchived !== false;
  if (/^C[A-Z0-9]{2,}$/.test(q)) {
    const byId = await sql<ChannelRow[]>`select * from directory_channels where id = ${q} and (${incl} or not is_archived)`;
    if (byId.length) return byId;
  }
  const n = channelNameForm(q);
  const npat = `%${likeEscape(n)}%`;
  const npre = `${likeEscape(n)}%`;
  const pat = `%${likeEscape(q)}%`;
  // Name: 6 exact, 5+ prefix, 4+ substring, 2×similarity fuzzy; topic / purpose: 1+ substring, else similarity (≤ 1).
  return sql<ChannelRow[]>`
    with m as (
      select c.*, greatest(
        case when name = ${n} then 6 when name ilike ${npre} then 5 + similarity(name, ${n}) when name ilike ${npat} then 4 + similarity(name, ${n}) else 2 * word_similarity(${n}, name) end,
        case when topic ilike ${pat} then 1 + word_similarity(${q}, topic) else word_similarity(${q}, topic) end,
        case when purpose ilike ${pat} then 1 + word_similarity(${q}, purpose) else word_similarity(${q}, purpose) end
      ) as score
      from directory_channels c
      where (${n} <% name or name ilike ${npat} or ${q} <% topic or ${q} <% purpose or topic ilike ${pat} or purpose ilike ${pat})
        and (${incl} or not is_archived)
    )
    select * from m order by score - (case when is_archived then 0.1 else 0 end) desc, coalesce(member_count, 0) desc, id
    limit ${limit}`;
}

/** Row counts (for the status line while a crawl runs). */
export async function directoryCounts(): Promise<{ people: number; channels: number }> {
  const [r] = await sql<{ people: number; channels: number }[]>`
    select (select count(*)::int from directory_people) as people, (select count(*)::int from directory_channels) as channels`;
  return r ?? { people: 0, channels: 0 };
}
