/**
 * Traces + eval export loading against the test Postgres (SLACK_FAKE=1).
 * Run: INTEGRATION=1 pnpm vitest run src/eval/eval.int.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INTEGRATION = process.env.INTEGRATION === '1';
const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe.skipIf(!INTEGRATION)('eval traces integration', () => {
  let sql: typeof import('../db/index.js').sql;
  let trace: typeof import('../agent/trace.js');
  let load: typeof import('./load.js');
  let detectors: typeof import('./detectors.js');
  let store: typeof import('../pipeline/store.js');
  let retention: typeof import('../features/retention.js');

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    trace = await import('../agent/trace.js');
    load = await import('./load.js');
    detectors = await import('./detectors.js');
    store = await import('../pipeline/store.js');
    retention = await import('../features/retention.js');
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
  });

  /** A finished turn: trigger message, a bot reply with a 👎, the author's correction, a front trace and one run. */
  async function seed(channel = `CEV${rand()}`) {
    const base = Math.floor(Date.now() / 1000) - 600 - Math.floor(Math.random() * 100);
    const threadTs = `${base}.000100`;
    const threadId = `${channel}:${threadTs}`;
    const user = `UEV${rand()}`;
    await sql`insert into threads (id, channel_id, thread_ts) values (${threadId}, ${channel}, ${threadTs})`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${channel}, ${threadTs}, ${threadId}, ${user}, 'what is the plan')`;
    await sql`insert into messages (channel_id, ts, thread_id, bot_id, text, reactions)
              values (${channel}, ${`${base + 5}.000100`}, ${threadId}, 'BBOT', 'the plan is x', ${sql.json([{ name: '-1', users: [user], count: 1 }])})`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${channel}, ${`${base + 60}.000100`}, ${threadId}, ${user}, 'no, I meant the launch plan')`;
    const [t] = await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, kind, is_mention, message_ts, status, created_at, started_at, finished_at)
      values (${threadId}, ${user}, 'user', true, ${[threadTs]}, 'done', to_timestamp(${base}), to_timestamp(${base + 1}), to_timestamp(${base + 10}))
      returning id`;
    const turnId = Number(t!.id);
    const r = new trace.TraceRecorder();
    r.ingest({ type: 'start-step' });
    r.ingest({ type: 'tool-call', toolCallId: 'a', toolName: 'slack_search', input: { query: 'plan' } });
    r.ingest({ type: 'tool-result', toolCallId: 'a', toolName: 'slack_search', output: `nothing${'.'.repeat(1000)}` });
    r.ingest({ type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 500, outputTokens: 20 } });
    await trace.saveTrace({ threadId, kind: 'front', turnId, model: 'test-model', system: 'SYSTEM PROMPT v1', input: [{ role: 'user', content: 'ctx' }], steps: r.finish(), outcome: 'done', startedAt: new Date() });
    const saId = `sa_${rand()}`;
    await sql`insert into subagents (id, thread_id, owner_id, title) values (${saId}, ${threadId}, ${user}, 'research')`;
    const [run] = await sql<{ id: number }[]>`
      insert into runs (subagent_id, thread_id, turn_id, instructions, status, tokens) values (${saId}, ${threadId}, ${turnId}, 'find the plan', 'complete', 1234) returning id`;
    await trace.saveTrace({ threadId, kind: 'run', turnId, runId: Number(run!.id), model: 'child-model', system: 'CHILD PROMPT', input: [{ role: 'user', content: 'find the plan' }], steps: [], outcome: 'done', startedAt: new Date() });
    await sql`insert into thread_events (thread_id, type, actor, payload) values (${threadId}, 'reply', 'bot', ${sql.json({ turnId, text: 'the plan is x' })})`;
    return { channel, threadTs, threadId, turnId, runId: Number(run!.id), since: new Date((base - 60) * 1000) };
  }

  it('saves traces and loads a scored turn with its context', async () => {
    const s = await seed();
    const turns = await load.loadTurns({ since: s.since });
    const t = turns.find((x) => x.turn.id === s.turnId)!;
    expect(t).toBeDefined();
    expect(t.request).toEqual([{ userId: expect.any(String), text: 'what is the plan' }]);
    // Scoring loads light traces: no input, results clipped.
    expect(t.trace).toMatchObject({ model: 'test-model', promptHash: trace.promptHash('SYSTEM PROMPT v1'), input: [], steps: [{ calls: [{ name: 'slack_search' }] }] });
    expect(t.trace!.steps[0]!.calls[0]!.output!.length).toBe(300);
    expect(t.runs).toMatchObject([{ id: s.runId, tokens: 1234, trace: { model: 'child-model' } }]);
    expect(t.reactions).toEqual([{ name: '-1', count: 1 }]);
    expect(t.followUps[0]).toMatchObject({ text: 'no, I meant the launch plan' });
    const scored = detectors.score(t);
    expect(scored.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['user_correction', 'negative_reaction']));
    const [full] = await load.loadFullTraces([t]);
    expect(full!.trace!.input).toEqual([{ role: 'user', content: 'ctx' }]);
    expect(full!.trace!.steps[0]!.calls[0]!.output!.length).toBe(1007);
    expect(full!.runs[0]!.trace).toMatchObject({ model: 'child-model' });
    const prompts = await load.loadPrompts([t.trace!.promptHash!]);
    expect(prompts.get(t.trace!.promptHash!)).toBe('SYSTEM PROMPT v1');
  });

  it('drops traces when a message they may hold is deleted, and after the retention window', async () => {
    const a = await seed();
    // Another thread in the same channel (its input can hold channel context) and one in another channel.
    const sibling = await seed(a.channel);
    const other = await seed();
    // A message posted after both traces finished can't be in them.
    const lateTs = `${Math.floor(Date.now() / 1000) + 5}.000100`;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${a.channel}, ${lateTs}, ${a.threadId}, 'ULATE', 'later')`;
    await store.applyDelete(a.channel, lateTs);
    expect(await sql`select id from traces where channel_id = ${a.channel}`).toHaveLength(4);
    // A message older than the traces is deleted: every trace in its channel goes, the other channel's stay.
    await store.applyDelete(a.channel, a.threadTs);
    expect(await sql`select id from traces where channel_id = ${a.channel}`).toHaveLength(0);
    expect(await sql`select id from traces where thread_id = ${other.threadId}`).toHaveLength(2);
    // The daily pass doesn't keep deleting newer traces in that channel.
    await trace.saveTrace({ threadId: sibling.threadId, kind: 'front', turnId: sibling.turnId, model: 'm', system: 's', input: [], steps: [], outcome: 'done', startedAt: new Date(Date.now() + 2000) });
    await retention.runRetention();
    expect(await sql`select id from traces where thread_id = ${sibling.threadId}`).toHaveLength(1);

    const b = await seed();
    await sql`update traces set created_at = now() - interval '40 days' where thread_id = ${b.threadId}`;
    await retention.runRetention();
    expect(await sql`select id from traces where thread_id = ${b.threadId}`).toHaveLength(0);
  });

  it('drops a trace saved after a message it may hold was deleted mid-turn', async () => {
    const s = await seed();
    const startedAt = new Date(Date.now() - 1000);
    await store.applyDelete(s.channel, s.threadTs);
    await trace.saveTrace({ threadId: s.threadId, kind: 'front', turnId: s.turnId, model: 'm', system: 's', input: [], steps: [], outcome: 'done', startedAt });
    expect(await sql`select id from traces where thread_id = ${s.threadId}`).toHaveLength(0);
  });

  it('saves traces with strings jsonb would reject', async () => {
    const s = await seed();
    const r = new trace.TraceRecorder();
    r.ingest({ type: 'start-step' });
    r.ingest({ type: 'tool-call', toolCallId: 'a', toolName: 'fetch_url', input: { url: 'x\u0000' } });
    r.ingest({ type: 'tool-result', toolCallId: 'a', toolName: 'fetch_url', output: `${'é'.repeat(5999)}😀😀` });
    r.ingest({ type: 'finish-step', finishReason: 'stop', usage: {} });
    await trace.saveTrace({ threadId: s.threadId, kind: 'front', turnId: s.turnId, model: 'm', system: 'nul\u0000', input: [{ role: 'user', content: 'a\ud83d' }], steps: r.finish(), outcome: 'done', startedAt: new Date() });
    expect(await sql`select id from traces where thread_id = ${s.threadId} and model = 'm'`).toHaveLength(1);
  });
});
