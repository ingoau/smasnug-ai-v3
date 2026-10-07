/**
 * Directory storage (directory_people / directory_channels, migration 270). Writes are upserts that skip true
 * no-ops: an unchanged row is not rewritten unless the caller `touch`es it (a crawl or a users.info refresh, which
 * must record that the row was confirmed).
 */
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { PEOPLE_FIELDS, personFromSlack, type DirectoryChannel, type DirectoryPerson } from './fields.js';

/** A stored person plus its bookkeeping timestamps. */
export type PersonRow = DirectoryPerson & { syncedAt: Date; updatedAt: Date };
export type ChannelRow = DirectoryChannel & { syncedAt: Date; updatedAt: Date };

/** snake_case column for a camelCase field. */
const col = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const PEOPLE_COLS = PEOPLE_FIELDS.map(col);
/** Columns compared for change detection (all but the id; locale only when known). */
const CHANGE_COLS = PEOPLE_COLS.filter((c) => c !== 'id');

const peopleDistinct = CHANGE_COLS.map((c) => (c === 'locale' ? `((excluded.locale is not null or excluded.deleted) and excluded.locale is distinct from p.locale)` : `excluded.${c} is distinct from p.${c}`)).join(' or ');
const peopleSet = CHANGE_COLS.map((c) => (c === 'locale' ? `locale = case when excluded.deleted then null else coalesce(excluded.locale, p.locale) end` : `${c} = excluded.${c}`)).join(', ');

export type UpsertResult = 'inserted' | 'updated' | 'touched' | 'unchanged';

/**
 * Upsert people rows in one statement. `touch`: also bump `synced_at` on unchanged rows (crawl pages, users.info
 * refreshes); without it (events) an unchanged row is left alone: no write at all. Returns what happened to each id.
 */
export async function upsertPeople(people: DirectoryPerson[], opts: { touch: boolean }): Promise<{ id: string; result: UpsertResult }[]> {
  if (!people.length) return [];
  // One row per id (a page can't repeat one, but be safe: the statement would fail on a duplicate key).
  const byId = new Map(people.map((p) => [p.id, p]));
  const rows = [...byId.values()].map((p) => Object.fromEntries(PEOPLE_FIELDS.map((k) => [col(k), p[k] ?? null])));
  const res = await sql.unsafe(
    `insert into directory_people as p (${PEOPLE_COLS.join(', ')}, synced_at, updated_at)
     select ${PEOPLE_COLS.join(', ')}, now(), now() from jsonb_populate_recordset(null::directory_people, $1::text::jsonb)
     on conflict (id) do update set
       ${peopleSet},
       synced_at = now(),
       updated_at = case when ${peopleDistinct} then now() else p.updated_at end
     where ${opts.touch ? 'true' : peopleDistinct}
     returning id, (xmax = 0) as inserted, (updated_at = now()) as changed`,
    [JSON.stringify(rows)] as any,
  );
  const written = new Map((res as any[]).map((r) => [r.id as string, (r.inserted ? 'inserted' : r.changed ? 'updated' : 'touched') as UpsertResult]));
  return [...byId.keys()].map((id) => ({ id, result: written.get(id) ?? 'unchanged' }));
}

/** One person from an event / lookup: what happened to the row (one statement; 'unchanged' = nothing written). */
export async function upsertPerson(person: DirectoryPerson, opts: { touch: boolean }): Promise<UpsertResult> {
  const [r] = await upsertPeople([person], opts);
  return r?.result ?? 'unchanged';
}

/**
 * Write-through for every users.info result anywhere (the directory is the one profile store): upsert it as a
 * confirmed (touched) row. Never throws.
 */
export async function rememberSlackUser(u: unknown): Promise<void> {
  const person = personFromSlack(u);
  if (!person) return;
  await upsertPerson(person, { touch: true }).catch((err) => log.warn({ err, userId: person.id }, 'directory write-through failed'));
}

export async function getPeople(ids: string[]): Promise<Map<string, PersonRow>> {
  const out = new Map<string, PersonRow>();
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return out;
  const rows = await sql<PersonRow[]>`select * from directory_people where id = any(${uniq})`;
  for (const r of rows) out.set(r.id, { ...r, statusExpiration: r.statusExpiration === null ? null : Number(r.statusExpiration) });
  return out;
}

export async function deletePeopleNotSyncedSince(since: Date): Promise<number> {
  const res = await sql`delete from directory_people where synced_at < ${since}`;
  return res.count;
}

// ---------- channels ----------

const CHANNEL_COLS = ['id', 'name', 'topic', 'purpose', 'is_archived', 'member_count', 'created_at'];
const channelDistinct = `excluded.name is distinct from c.name or excluded.topic is distinct from c.topic or excluded.purpose is distinct from c.purpose
  or excluded.is_archived is distinct from c.is_archived or (excluded.member_count is not null and excluded.member_count is distinct from c.member_count)
  or (excluded.created_at is not null and excluded.created_at is distinct from c.created_at)`;

/** Upsert public channels (rows built by channelFromSlack only). `touch` as for upsertPeople. */
export async function upsertChannels(channels: DirectoryChannel[], opts: { touch: boolean }): Promise<number> {
  if (!channels.length) return 0;
  const byId = new Map(channels.map((c) => [c.id, c]));
  const rows = [...byId.values()].map((c) => ({
    id: c.id,
    name: c.name,
    topic: c.topic,
    purpose: c.purpose,
    is_private: false,
    is_archived: c.isArchived,
    member_count: c.memberCount,
    created_at: c.createdAt ? c.createdAt.toISOString() : null,
  }));
  const res = await sql.unsafe(
    `insert into directory_channels as c (${CHANNEL_COLS.join(', ')}, synced_at, updated_at)
     select ${CHANNEL_COLS.join(', ')}, now(), now() from jsonb_populate_recordset(null::directory_channels, $1::text::jsonb)
     on conflict (id) do update set
       name = excluded.name, topic = excluded.topic, purpose = excluded.purpose, is_archived = excluded.is_archived,
       member_count = coalesce(excluded.member_count, c.member_count), created_at = coalesce(excluded.created_at, c.created_at),
       synced_at = now(),
       updated_at = case when ${channelDistinct} then now() else c.updated_at end
     where ${opts.touch ? 'true' : channelDistinct}
     returning id`,
    [JSON.stringify(rows)] as any,
  );
  return res.length;
}

/** Field updates on an existing (public) channel row; a no-op when the row is missing or the value is the same. */
export async function updateChannel(id: string, patch: { name?: string; topic?: string; purpose?: string; isArchived?: boolean }): Promise<boolean> {
  const res = await sql`
    update directory_channels set
      name = coalesce(${patch.name ?? null}, name),
      topic = coalesce(${patch.topic ?? null}, topic),
      purpose = coalesce(${patch.purpose ?? null}, purpose),
      is_archived = coalesce(${patch.isArchived ?? null}, is_archived),
      synced_at = now(), updated_at = now()
    where id = ${id} and (
      (${patch.name ?? null}::text is not null and name is distinct from ${patch.name ?? null}) or
      (${patch.topic ?? null}::text is not null and topic is distinct from ${patch.topic ?? null}) or
      (${patch.purpose ?? null}::text is not null and purpose is distinct from ${patch.purpose ?? null}) or
      (${patch.isArchived ?? null}::boolean is not null and is_archived is distinct from ${patch.isArchived ?? null})
    )`;
  return res.count > 0;
}

export async function deleteChannel(id: string): Promise<boolean> {
  return (await sql`delete from directory_channels where id = ${id}`).count > 0;
}

/**
 * Public channels among `ids` that the directory confirmed (crawl, event or a conversations.info write-through)
 * within `maxAgeMs`: id → name. Rows older than that aren't trusted (the caller re-verifies them); missing ids aren't
 * in the result. The table only ever holds public channels (check constraint), so a hit means "public".
 */
export async function knownPublicChannels(ids: string[], maxAgeMs: number): Promise<Map<string, string>> {
  const uniq = [...new Set(ids)].filter((id) => typeof id === 'string' && id.startsWith('C'));
  if (!uniq.length) return new Map();
  const rows = await sql<{ id: string; name: string }[]>`
    select id, name from directory_channels
    where id = any(${uniq}) and not is_private and synced_at > now() - ${maxAgeMs / 1000} * interval '1 second'`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function channelExists(id: string): Promise<boolean> {
  return (await sql`select 1 from directory_channels where id = ${id}`).length > 0;
}

export async function deleteChannelsNotSyncedSince(since: Date): Promise<number> {
  return (await sql`delete from directory_channels where synced_at < ${since}`).count;
}
