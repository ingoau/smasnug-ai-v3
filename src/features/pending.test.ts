import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { loadPendingActions, renderPendingActions } from './pending.js';

const user = `UPA${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const other = `${user}X`;
const threadId = `CPA${user}:1790000000.000100`;

afterAll(async () => {
  await sql`delete from pending_sends where requester_id in (${user}, ${other})`;
  await sql`delete from pending_coding_agents where owner_id in (${user}, ${other})`;
  await sql`delete from reminders where owner_id in (${user}, ${other})`;
  await sql`delete from watches where owner_id in (${user}, ${other})`;
  await sql`delete from previews where requester_id in (${user}, ${other})`;
  await sql`delete from threads where id = ${threadId}`;
  await sql.end();
});

describe('renderPendingActions', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  it('is empty when nothing is pending', () => {
    expect(renderPendingActions({ sends: [], codingAgents: [], reminders: 0, watches: 0, previewTerms: 0, previewClaims: 0 }, now)).toBe('');
  });

  it('one compact line per kind', () => {
    const out = renderPendingActions(
      {
        sends: [{ destination: 'C123', expiresAt: new Date('2026-10-07T12:03:00Z') }, { destination: 'U9', expiresAt: new Date('2026-10-07T12:00:10Z') }],
        codingAgents: ['Fix the "card" <title>'],
        reminders: 2,
        watches: 1,
        previewTerms: 1,
        previewClaims: 0,
      },
      now,
    );
    expect(out.split('\n')).toEqual([
      'send_message previews waiting for their Send click (nothing sent yet): to <#C123>, expires in 3 min; to <@U9>, expires in 1 min',
      'Coding-agent previews not launched yet (they press Launch): "Fix the  card   title "',
      "Live previews waiting for them to accept Cloudflare's terms (in the ephemeral prompt): 1",
      'Active: 2 reminders, 1 watch (list_reminders / list_watches for details)',
    ]);
  });
});

describe('loadPendingActions', () => {
  it("counts only the speaker's live items", async () => {
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${`CPA${user}`}, '1790000000.000100') on conflict do nothing`;
    await sql`insert into pending_sends (requester_id, destination, text, expires_at) values
      (${user}, 'C1', 'hi', now() + interval '4 minutes'),
      (${user}, 'C2', 'old', now() - interval '1 minute'),
      (${other}, 'C3', 'theirs', now() + interval '4 minutes')`;
    await sql`insert into pending_coding_agents (thread_id, owner_id, title, instructions, expires_at) values (${threadId}, ${user}, 'Fix X', 'do it', now() + interval '10 minutes')`;
    await sql`insert into reminders (owner_id, thread_id, channel_id, text, due_at) values
      (${user}, ${threadId}, 'C1', 'a', now() + interval '1 day'),
      (${user}, ${threadId}, 'C1', 'b', now() + interval '2 days')`;
    await sql`insert into reminders (owner_id, thread_id, channel_id, text, due_at, status) values (${user}, ${threadId}, 'C1', 'c', now(), 'fired')`;
    await sql`insert into watches (owner_id, thread_id, channel_id, source, target, criteria, interval_s, next_check_at, expires_at) values
      (${user}, ${threadId}, 'C1', 'url', 'https://example.com', 'changes', 3600, now(), now() + interval '1 day')`;
    await sql`insert into previews (id, thread_id, requester_id, title, status) values (${`pv_${user}`}, ${threadId}, ${user}, 'Page', 'awaiting_terms')`;
    const p = await loadPendingActions(user);
    expect(p.sends.map((s) => s.destination)).toEqual(['C1']);
    expect(p.codingAgents).toEqual(['Fix X']);
    expect(p).toMatchObject({ reminders: 2, watches: 1, previewTerms: 1, previewClaims: 0 });
    expect(renderPendingActions(await loadPendingActions(`${user}NOBODY`))).toBe('');
  });
});
