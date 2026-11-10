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
    sql<{ id: string; source: string; categories: string[]; turnId: string | null; evidence: any[]; reviewVerdict: string | null }[]>`
      select id, source, categories, turn_id, evidence, review_verdict from failure_reports where thread_id = ${threadId} order by id`;

  let turnA: number;
  let turnB: number;

  beforeAll(async () => {
    ({ sql } = await import('../../db/index.js'));
    tool = await import('./tool.js');
    review = await import('./review.js');
    await sql`delete from threads where id = ${threadId}`;
    await sql`insert into threads (id, channel_id, thread_ts, last_activity_at) values (${threadId}, ${channel}, ${ts(0)}, ${at(10)})`;
    const msg = (i: number, text: string, bot = false) =>
      sql`insert into messages (channel_id, ts, thread_id, user_id, bot_id, text)
          values (${channel}, ${ts(i)}, ${threadId}, ${bot ? null : user}, ${bot ? 'B_FAILX' : null}, ${text})`;
    await msg(0, 'FAILX when does the hackathon start?');
    await msg(1, 'It starts at 9am.', true);
    await msg(2, 'FAILX also is there food?');
    await msg(3, 'hello?? no answer, and it starts at 10 not 9');
    await msg(4, 'Sorry, it starts at 10.', true);
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
  });

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

  it('the review files cited findings, maps them to turns, and gives verdicts on self reports', async () => {
    const [self] = await reports();
    reply = {
      findings: [
        { categories: ['incorrect_info'], summary: 'wrong start time', evidence_lines: [2, 4], bot_line: 2, signal: 'correction' },
        { categories: ['gate_false_negative'], summary: 'food question skipped', evidence_lines: [3, 4], bot_line: null, signal: 'explicit_complaint' },
        { categories: ['gate_false_negative'], summary: 'no gate decision here', evidence_lines: [1], bot_line: null, signal: 'hindsight' },
        { categories: ['incomplete'], summary: 'uncited', evidence_lines: [42], bot_line: null, signal: 'hindsight' },
      ],
      self_reports: [{ id: Number(self!.id), verdict: 'confirmed' }, { id: 999999999, verdict: 'disputed' }],
    };
    await sql`update threads set failures_reviewed_at = null where id = ${threadId}`;
    await review.runFailureReview();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('{gate: NOT answered, p=0.30}');
    expect(prompts[0]).toContain('said 9am, it is 10');
    const rows = (await reports()).filter((r) => r.source === 'review');
    expect(rows.map((r) => [r.categories, r.turnId])).toEqual([
      [['incorrect_info'], String(turnA)],
      [['gate_false_negative'], String(turnB)],
    ]);
    expect((await reports())[0]!.reviewVerdict).toBe('confirmed');
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
        { categories: ['gate_false_negative'], summary: 'food question still skipped', evidence_lines: [3, 6], bot_line: null, signal: 'explicit_complaint' },
      ],
      self_reports: [],
    };
    await review.reviewThread(threadId, at(10), { force: true });
    expect(prompts.at(-1)).toContain('Already reported by an earlier review');
    expect(prompts.at(-1)).toContain('food question skipped');
    // The first cites nothing newer than the last review; the second has the same anchor and category as before.
    expect((await reports()).filter((r) => r.source === 'review')).toHaveLength(2);
  });

  it('a deleted Slack message drops the channel reports since then; privacy withdraw drops the rest of theirs', async () => {
    const { applyDelete } = await import('../../pipeline/store.js');
    await sql`update failure_reports set created_at = ${at(1)} where thread_id = ${threadId} and source = 'self'`;
    await sql`delete from messages where thread_id = ${threadId} and ts = ${ts(20)}`;
    await applyDelete(channel, ts(2));
    expect((await reports()).map((r) => r.source)).toEqual(['self']);
    // The SQL that handlePrivacyWithdraw runs.
    await sql`delete from failure_reports where speaker_id = ${user} or evidence @> ${sql.json([{ userId: user }] as any)}`;
    expect(await reports()).toEqual([]);
  });
});
