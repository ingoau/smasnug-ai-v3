/**
 * Failure reports against real Postgres + Redis (model call mocked): report_failure, the background review, and the
 * deletion paths. Needs local infra: LIVE=1.
 *   LIVE=1 pnpm vitest run src/features/failures/failures.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const LIVE = process.env.LIVE === '1';
vi.hoisted(() => {
  if (process.env.LIVE === '1') {
    try {
      process.loadEnvFile('.env');
    } catch {}
    process.env.SLACK_FAKE = '1';
    process.env.LOG_LEVEL ??= 'warn';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});

const prompts: string[] = [];
let reply: unknown = { findings: [], self_reports: [] };
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateText: async (opts: { prompt: string }) => {
    // Other test files' threads may be reviewed in the same run: only this test's threads get findings.
    if (!opts.prompt.includes('FAILX')) return { output: { findings: [], self_reports: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    prompts.push(opts.prompt);
    return { output: reply, usage: { inputTokens: 1, outputTokens: 1 } };
  },
}));
vi.mock('../guard.js', () => ({ recordModelUsage: async () => {} }));
vi.mock('../util.js', async (orig) => ({ ...(await orig<typeof import('../util.js')>()), userProfile: async (id: string) => ({ name: `name-${id}` }) }));

describe.skipIf(!LIVE)('failure reports (DB)', () => {
  let sql: typeof import('../../db/index.js').sql;
  let tool: typeof import('./tool.js');
  let review: typeof import('./review.js');
  const user = 'U_FAILX';
  const channel = 'C_FAILX_TEST';
  const base = Math.floor(Date.now() / 1000) - 7200;
  const ts = (i: number) => `${base + i}.000000`;
  const threadId = `${channel}:${ts(0)}`;
  const at = (i: number) => new Date((base + i) * 1000);

  const ctx = (turnId: number) => ({
    role: 'front' as const,
    threadId,
    channelId: channel,
    threadTs: ts(0),
    speakerId: user,
    turnId,
    extras: { defaultReactTs: ts(3) },
  });
  const reports = () =>
    sql<{ id: string; source: string; categories: string[]; turnId: string | null; evidence: any[]; reviewVerdict: string | null; mergedKeys: string[] }[]>`
      select id, source, categories, turn_id, evidence, review_verdict, merged_keys from failure_reports where thread_id = ${threadId} order by id`;

  let turnA: number;
  let turnB: number;

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    tool = await import('./tool.js');
    review = await import('./review.js');
    await sql`delete from threads where id = ${threadId}`;
    await sql`insert into threads (id, channel_id, thread_ts, last_activity_at) values (${threadId}, ${channel}, ${ts(0)}, ${at(10)})`;
    // Our bot is the fake Slack's auth.test identity (UBOT / BBOT); kyto is another bot in the thread.
    const msg = (i: number, text: string, bot: false | 'ours' | 'kyto' = false) =>
      sql`insert into messages (channel_id, ts, thread_id, user_id, bot_id, username, text)
          values (${channel}, ${ts(i)}, ${threadId}, ${bot === 'ours' ? 'UBOT' : bot === 'kyto' ? 'U_KYTO' : user},
                  ${bot === 'ours' ? 'BBOT' : bot === 'kyto' ? 'B_KYTO' : null}, ${bot === 'kyto' ? 'kyto' : null}, ${text})`;
    await msg(0, 'FAILX when does the hackathon start?');
    await msg(1, 'It starts at 9am.', 'ours');
    await msg(2, 'FAILX also is there food?');
    await msg(3, 'hello?? no answer, and it starts at 10 not 9');
    await msg(4, 'Sorry, it starts at 10.', 'ours');
    await msg(5, 'The hackathon is on Mars.', 'kyto');
    turnA = (await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, status, message_ts, created_at, started_at, finished_at)
      values (${threadId}, ${user}, 'done', ${[ts(0)]}, ${at(0)}, ${at(0)}, ${at(1)}) returning id::int`)[0]!.id;
    turnB = (await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, status, message_ts, created_at, started_at, finished_at)
      values (${threadId}, ${user}, 'done', ${[ts(3)]}, ${at(3)}, ${at(3)}, ${at(4)}) returning id::int`)[0]!.id;
    await sql`insert into thread_events (thread_id, type, actor, payload, created_at)
              values (${threadId}, 'gate_decision', 'system', ${sql.json({ messageTs: [ts(2)], authorId: user, decision: 'no', probability: 0.3 })}, ${at(2)})`;
  });

  afterAll(async () => {
    await sql`delete from threads where id = ${threadId}`;
    await sql`delete from threads where id = ${thread2}`;
  });

  // A second thread in its own channel (applyDelete is channel-wide).
  const channel2 = 'C_FAILX_TEST2';
  const thread2 = `${channel2}:${ts(100)}`;

  it('report_failure stores one report per turn with evidence quoted from our copy', async () => {
    expect(await tool.fileSelfReport(ctx(turnB), { categories: ['incorrect_info', 'other'], summary: 'said 9am, it is 10', signal: 'correction' })).toBe(tool.NOTED);
    expect(await tool.fileSelfReport(ctx(turnB), { categories: ['incomplete'], summary: 'again', signal: 'correction' })).toBe(tool.ALREADY_NOTED);
    const [r] = await reports();
    expect(r).toMatchObject({ source: 'self', categories: ['incorrect_info'], turnId: String(turnB) });
    expect(r!.evidence).toEqual([{ ts: ts(3), userId: user, quote: 'hello?? no answer, and it starts at 10 not 9' }]);
    const [ev] = await sql<{ payload: any }[]>`select payload from thread_events where thread_id = ${threadId} and type = 'failure_report'`;
    expect(ev!.payload).toMatchObject({ source: 'self', turnId: turnB, categories: ['incorrect_info'] });
    expect(JSON.stringify(ev!.payload)).not.toContain('hello??');
  });

  it('the review files cited findings about this bot, merges overlapping ones, and gives verdicts on self reports', async () => {
    const [self] = await reports();
    reply = {
      findings: [
        // Shares the complaint (line 4) with the self report: merged into it, which confirms it.
        { categories: ['incorrect_info'], summary: 'wrong start time', evidence_lines: [2, 4], bot_line: 2, signal: 'hindsight' },
        { categories: ['gate_false_negative', 'missed_context'], summary: 'food question skipped', evidence_lines: [3], bot_line: null, signal: 'explicit_complaint' },
        // Same evidence and a category in common with the one above: merged into it.
        { categories: ['missed_context'], summary: 'ignored the food question', evidence_lines: [3], bot_line: null, signal: 'hindsight' },
        // Same evidence, nothing in common: a separate failure.
        { categories: ['format_or_tone'], summary: 'too terse', evidence_lines: [3, 2], bot_line: 2, signal: 'hindsight' },
        { categories: ['gate_false_negative'], summary: 'no gate decision here', evidence_lines: [1], bot_line: null, signal: 'hindsight' },
        { categories: ['incomplete'], summary: 'uncited', evidence_lines: [42], bot_line: null, signal: 'hindsight' },
        // Another bot's mistake: never ours.
        { categories: ['incorrect_info'], summary: 'kyto said Mars', evidence_lines: [6], bot_line: 6, signal: 'hindsight' },
      ],
      self_reports: [{ id: Number(self!.id), verdict: 'confirmed' }, { id: 999999999, verdict: 'disputed' }],
    };
    await sql`update threads set failures_reviewed_at = null where id = ${threadId}`;
    await review.runFailureReview();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('{gate: NOT answered, p=0.30}');
    expect(prompts[0]).toContain('said 9am, it is 10');
    expect(prompts[0]).toContain('(the bot under review): It starts at 9am.');
    expect(prompts[0]).toContain('[6] [other bot] kyto: The hackathon is on Mars.');
    const all = await reports();
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ source: 'self', categories: ['incorrect_info'], turnId: String(turnB), reviewVerdict: 'confirmed' });
    expect(all[0]!.evidence.map((e: any) => e.ts)).toEqual([ts(1), ts(3)]);
    expect(all[0]!.evidence[0]).toEqual({ ts: ts(1), userId: 'UBOT', quote: 'It starts at 9am.' });
    expect(all[0]!.mergedKeys).toHaveLength(1);
    expect(all[1]).toMatchObject({ source: 'review', categories: ['gate_false_negative', 'missed_context'], turnId: null, mergedKeys: [expect.stringContaining('missed_context')] });
    expect(all[2]).toMatchObject({ source: 'review', categories: ['format_or_tone'], turnId: String(turnA), mergedKeys: [] });
    const verdicts = await sql<{ payload: any }[]>`select payload from thread_events where thread_id = ${threadId} and type = 'failure_verdict'`;
    expect(verdicts.map((v) => v.payload.verdict)).toContain('confirmed');
    const [th] = await sql<{ failuresReviewedAt: Date | null }[]>`select failures_reviewed_at from threads where id = ${threadId}`;
    expect(th!.failuresReviewedAt).not.toBeNull();

    // Nothing new in the thread: not picked again.
    await review.runFailureReview();
    expect(prompts).toHaveLength(1);
  });

  it('a re-review never files an earlier finding again', async () => {
    // New activity: the thread is picked again, and the model repeats an old finding plus one about the new message.
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${channel}, ${ts(20)}, ${threadId}, ${user}, 'you still did not answer about food')`;
    await sql`update threads set last_activity_at = ${at(20)}, failures_reviewed_at = ${at(10)} where id = ${threadId}`;
    reply = {
      findings: [
        { categories: ['incorrect_info'], summary: 'wrong start time again', evidence_lines: [2, 4], bot_line: 2, signal: 'correction' },
        { categories: ['gate_false_negative'], summary: 'food question still skipped', evidence_lines: [3, 7], bot_line: null, signal: 'explicit_complaint' },
        // Merged into the earlier finding before; its key is still known.
        { categories: ['missed_context'], summary: 'still ignored food', evidence_lines: [3, 7], bot_line: null, signal: 'hindsight' },
      ],
      self_reports: [],
    };
    await review.reviewThread(threadId, at(10), { force: true });
    expect(prompts.at(-1)).toContain('Already reported');
    expect(prompts.at(-1)).toContain('food question skipped (an earlier review)');
    // A judged self report is on file too.
    expect(prompts.at(-1)).toContain('said 9am, it is 10 (the bot itself, confirmed by a review)');
    // The first cites nothing newer than the last review; the others have the same anchor and categories as before.
    const all = await reports();
    expect(all).toHaveLength(3);
    expect(all[1]!.mergedKeys).toHaveLength(1);
  });

  it('a self report on an incident the review already filed merges into it, and its retry is a no-op', async () => {
    const turnC = (await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, status, message_ts, created_at, started_at, finished_at)
      values (${threadId}, ${user}, 'done', ${[ts(20)]}, ${at(20)}, ${at(20)}, ${at(21)}) returning id::int`)[0]!.id;
    const input = { categories: ['gate_false_negative'], summary: 'missed the food question', signal: 'explicit_complaint' as const, messageTs: [ts(2)] };
    expect(await tool.fileSelfReport(ctx(turnC), input)).toBe(tool.NOTED);
    expect(await tool.fileSelfReport(ctx(turnC), input)).toBe(tool.ALREADY_NOTED);
    const all = await reports();
    expect(all).toHaveLength(3);
    expect(all[1]).toMatchObject({ source: 'self', reviewVerdict: 'confirmed', categories: ['gate_false_negative', 'missed_context'] });
    expect(all[1]!.mergedKeys).toHaveLength(2);
  });

  it('a deleted Slack message drops the channel reports since then; privacy withdraw drops the rest of theirs', async () => {
    const { applyDelete } = await import('../../pipeline/store.js');
    const [first] = await reports();
    await sql`update failure_reports set created_at = ${at(1)} where id = ${first!.id}`;
    await sql`delete from messages where thread_id = ${threadId} and ts = ${ts(20)}`;
    await applyDelete(channel, ts(2));
    expect((await reports()).map((r) => r.source)).toEqual(['self']);
    // The SQL that handlePrivacyWithdraw runs.
    await sql`delete from failure_reports where speaker_id = ${user} or evidence @> ${sql.json([{ userId: user }] as any)}`;
    expect(await reports()).toEqual([]);
  });

  it('verdicts before findings, our miss next to another bot, and a deleted message drops every report quoting it', async () => {
    const { recordFailure } = await import('./store.js');
    const { applyDelete } = await import('../../pipeline/store.js');
    await sql`delete from threads where id = ${thread2}`;
    await sql`insert into threads (id, channel_id, thread_ts, last_activity_at) values (${thread2}, ${channel2}, ${ts(100)}, ${at(104)})`;
    const msg = (i: number, text: string, bot: false | 'ours' | 'kyto' = false) =>
      sql`insert into messages (channel_id, ts, thread_id, user_id, bot_id, username, text)
          values (${channel2}, ${ts(i)}, ${thread2}, ${bot === 'ours' ? 'UBOT' : bot === 'kyto' ? 'U_KYTO' : user},
                  ${bot === 'ours' ? 'BBOT' : bot === 'kyto' ? 'B_KYTO' : null}, ${bot === 'kyto' ? 'kyto' : null}, ${text})`;
    await msg(100, 'FAILX what is the deadline?');
    await msg(101, 'Friday.', 'ours');
    await msg(102, 'no, it is Thursday');
    await msg(103, 'FAILX is there parking?');
    await msg(104, 'Yes, lot B.', 'kyto');
    const turn = (await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, status, message_ts, created_at, started_at, finished_at)
      values (${thread2}, ${user}, 'done', ${[ts(100)]}, ${at(100)}, ${at(100)}, ${at(101)}) returning id::int`)[0]!.id;
    const selfId = await recordFailure({
      threadId: thread2,
      channelId: channel2,
      turnId: turn,
      source: 'self',
      categories: ['incorrect_info'],
      summary: 'FAILX wrong deadline',
      signal: 'correction',
      evidence: [{ ts: ts(102), userId: user, quote: 'no, it is Thursday' }],
      speakerId: user,
      idempotencyKey: `failure:test:${thread2}:self`,
    });
    reply = {
      findings: [
        // Same turn and category as the self report, which this pass disputes: filed on its own, not buried.
        { categories: ['incorrect_info'], summary: 'said Friday, it is Thursday', evidence_lines: [2, 3], bot_line: 2, signal: 'correction' },
        // We stayed silent and kyto answered: still our miss.
        { categories: ['incomplete'], summary: 'parking question left to kyto', evidence_lines: [4, 5], bot_line: null, signal: 'hindsight' },
      ],
      self_reports: [{ id: selfId, verdict: 'disputed' }],
    };
    await review.reviewThread(thread2, null, { force: true });
    const rows = () =>
      sql<{ id: string; source: string; categories: string[]; reviewVerdict: string | null; evidence: any[] }[]>`
        select id, source, categories, review_verdict, evidence from failure_reports where thread_id = ${thread2} order by id`;
    const all = await rows();
    expect(all.map((r) => [r.source, r.categories, r.reviewVerdict])).toEqual([
      ['self', ['incorrect_info'], 'disputed'],
      ['review', ['incorrect_info'], null],
      ['review', ['incomplete'], null],
    ]);
    // A second verdict never overwrites the first.
    reply = { findings: [], self_reports: [{ id: selfId, verdict: 'confirmed' }] };
    await review.reviewThread(thread2, null, { force: true });
    expect((await rows())[0]!.reviewVerdict).toBe('disputed');

    // Every report predates the deleted message (as when a merge adds a later quote to an older report): only the
    // one quoting it goes.
    await sql`update failure_reports set created_at = ${at(100)} where thread_id = ${thread2}`;
    await applyDelete(channel2, ts(104));
    const left = await rows();
    expect(left).toHaveLength(2);
    expect(left.flatMap((r) => r.evidence.map((e: any) => e.ts))).not.toContain(ts(104));
  });
});
