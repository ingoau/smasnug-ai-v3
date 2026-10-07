/**
 * Integration tests (LIVE=1): real Postgres/Redis (from .env), SLACK_FAKE Slack, real OpenRouter.
 * Other modules' contracts (thread rendering, requestTurn) are replaced with test doubles.
 *   LIVE=1 pnpm vitest run src/agent/agent.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { streamArgsText } from './slack-markdown.js';

const LIVE = process.env.LIVE === '1';
if (LIVE) {
  try {
    process.loadEnvFile('.env');
  } catch {}
  process.env.SLACK_FAKE = '1';
  process.env.LOG_LEVEL ??= 'warn';
  // Coding agents on (fake key: a proposal never calls Cursor before Launch), with a test admin, for the musing case.
  process.env.ADMIN_USER_ID = 'U_LIVEADMIN';
  process.env.CURSOR_API_KEY ||= 'crsr_live_test';
  process.env.CURSOR_REPO ||= 'https://github.com/example/repo';
}

/** Sandbox access per test: `deny` makes canUseSandbox refuse like an unverified user. */
const sandboxAccess = vi.hoisted(() => ({ deny: false }));
vi.mock('../sandbox/access.js', async (orig) => {
  const m = await orig<typeof import('../sandbox/access.js')>();
  return { ...m, canUseSandbox: async (userId: string) => (sandboxAccess.deny ? { ok: false as const, reason: 'denied' as const } : m.canUseSandbox(userId)) };
});

const requested: any[] = [];
const threadText = new Map<string, { history: string; newMessages: string; channelContext?: string }>();

vi.mock('../context/thread.js', () => ({
  renderThreadContext: async (threadId: string) => ({
    history: threadText.get(threadId)?.history ?? '',
    channelContext: threadText.get(threadId)?.channelContext ?? '',
    newMessages: threadText.get(threadId)?.newMessages ?? '',
  }),
  renderMessages: async (_threadId: string, ts: string[]) => ts.map((t) => `<@U_TEST> Tester: (message ${t})`).join('\n'),
}));

vi.mock('../pipeline/scheduler.js', () => ({
  requestTurn: async (opts: any) => {
    const { sql } = await import('../db/index.js');
    const [row] = await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, kind, card_id, is_mention, message_ts)
      values (${opts.threadId}, ${opts.authorId}, ${opts.kind}, ${opts.cardId ?? null}, ${opts.isMention ?? false}, ${opts.messageTs ?? []}) returning id`;
    requested.push({ ...opts, turnId: Number(row!.id) });
    return Number(row!.id);
  },
}));

describe.skipIf(!LIVE)('agent integration (LIVE)', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;

  const user = `U_TEST${Date.now().toString(36).toUpperCase()}`;
  const channel = 'C_AGENT_TEST';
  const rootTs = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const threadId = `${channel}:${rootTs}`;

  const io = (isMention = true) => ({
    drainInbox: async () => [],
    setPhase: async () => {},
    isMention,
  });

  async function insertTurn(kind: 'user' | 'synthesis', messageTs: string[], cardId: number | null = null) {
    const [row] = await sql<any[]>`
      insert into turns (thread_id, author_id, kind, is_mention, message_ts, card_id, status)
      values (${threadId}, ${user}, ${kind}, true, ${messageTs}, ${cardId}, 'running') returning *`;
    return { ...row, id: Number(row.id), cardId: row.cardId ? Number(row.cardId) : null };
  }

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    ({ fakeCalls } = await import('../core/slack-fake.js'));
    await import('./register.js');
    await import('../tools/index.js');
    await import('../features/register.js');
    await redis.del('slack:fake:calls');
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${threadId}, ${channel}, ${rootTs}, true) on conflict do nothing`;
  });

  afterAll(async () => {
    if (!LIVE) return;
    const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
    await queue(QUEUE.subagentRun).obliterate({ force: true }).catch(() => {});
    await queue(QUEUE.cardRender).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await redis.quit();
    await sql.end();
  });

  it('front turn spawns a subagent, the run completes, synthesis streams below the frozen card', async () => {
    const { runFrontTurn } = await import('./front.js');
    const { processSubagentRun } = await import('./child.js');
    const { processCardRender } = await import('./cards.js');

    threadText.set(threadId, {
      history: `<@${user}> Tester: hey bot`,
      newMessages: `<@${user}> Tester: @Smasnug please start a background subagent (spawn_subagent) to write a short comparison of the programming languages Rust and Go (3 bullet points each). Don't answer yourself — delegate it.`,
    });
    const turn1 = await insertTurn('user', [rootTs]);
    await runFrontTurn(turn1, io());

    const subagents = await sql<any[]>`select * from subagents where thread_id = ${threadId}`;
    expect(subagents.length).toBeGreaterThanOrEqual(1);
    expect(subagents[0].ownerId).toBe(user);
    const runs = await sql<any[]>`select * from runs where thread_id = ${threadId} order by id`;
    expect(runs.length).toBe(subagents.length);
    const cardId = Number(runs[0].cardId);
    const [card] = await sql<any[]>`select * from cards where id = ${cardId}`;
    expect(card.turnId).toBe(String(turn1.id));
    expect(card.messageTs).toBeTruthy();

    let calls = await fakeCalls();
    const hasPlan = (c: any) => c.args.blocks?.some((b: any) => b.type === 'plan');
    const replied = (await sql<any[]>`select 1 from thread_events where thread_id = ${threadId} and type = 'reply'`).length > 0;
    const cardMsg = calls.find((c) => (c.method === 'chat.postMessage' || c.method === 'chat.update') && hasPlan(c) && c.args.channel === channel);
    expect(cardMsg).toBeTruthy();
    expect(cardMsg!.args.text).toBeTruthy();
    if (replied) {
      // The card lives in the turn's reply: chat.update of that message, no separate card post.
      expect(cardMsg!.method).toBe('chat.update');
      expect(cardMsg!.args.ts).toBe(card.messageTs);
      expect(cardMsg!.args.blocks.map((b: any) => b.type)).toEqual(['plan', 'markdown']); // one card, above the reply
      expect(calls.some((c) => c.method === 'chat.postMessage' && hasPlan(c) && c.args.channel === channel)).toBe(false);
    } else {
      expect(cardMsg!.method).toBe('chat.postMessage');
      expect(cardMsg!.args.thread_ts).toBe(rootTs);
    }
    expect(cardMsg!.args.blocks.some((b: any) => b.type === 'actions')).toBe(false);
    const events1 = await sql<any[]>`select type from thread_events where thread_id = ${threadId}`;
    expect(events1.map((e) => e.type)).toContain('spawn');

    // Run every subagent (the worker would do this via the subagent-run queue).
    for (const r of runs) await processSubagentRun(Number(r.id));
    const done = await sql<any[]>`select * from runs where thread_id = ${threadId} order by id`;
    for (const r of done) {
      expect(r.status).toBe('complete');
      expect(r.output).toBeTruthy();
      expect(r.result).toBeTruthy();
    }
    const [sa] = await sql<any[]>`select * from subagents where id = ${subagents[0].id}`;
    expect(sa.status).toBe('idle');
    expect(sa.summary).toBeTruthy();
    expect(Array.isArray(sa.history) && sa.history.length).toBeGreaterThanOrEqual(2);

    // Exactly one synthesis request for the card.
    const synth = requested.filter((r) => r.cardId === cardId);
    expect(synth).toHaveLength(1);
    expect(synth[0]).toMatchObject({ threadId, authorId: user, kind: 'synthesis' });

    await processCardRender(cardId);
    calls = await fakeCalls();
    const update = calls.filter((c) => c.method === 'chat.update' && c.args.ts === card.messageTs).at(-1);
    // Everything done: a finished plan (Slack shows it collapsed to its title), every run listed and final.
    expect(update?.args.blocks[0]).toMatchObject({ type: 'plan', block_id: `card_${cardId}_plan` });
    expect(update?.args.blocks[0].title).toMatch(/ran \d subagents?/i);
    const runTasks = update?.args.blocks[0].tasks.filter((t: any) => t.task_id.startsWith('run_'));
    expect(runTasks).toHaveLength(done.length);
    expect(runTasks.every((t: any) => t.status === "complete")).toBe(true);

    // Synthesis turn.
    const before = calls.length;
    const [synthTurn] = await sql<any[]>`select * from turns where id = ${synth[0].turnId}`;
    await runFrontTurn({ ...synthTurn, id: Number(synthTurn.id), cardId: Number(synthTurn.cardId), messageTs: [] }, io(false));

    calls = (await fakeCalls()).slice(before);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('chat.startStream');
    expect(methods).toContain('chat.stopStream');
    const start = calls.find((c) => c.method === 'chat.startStream')!;
    expect(start.args.thread_ts).toBe(rootTs);
    expect(start.args.recipient_user_id).toBe(user);
    const streamed = calls.filter((c) => c.method === 'chat.startStream' || c.method === 'chat.appendStream').map((c) => streamArgsText(c.args)).join('');
    expect(streamed.length).toBeGreaterThan(20);

    const frozen = calls.filter((c) => c.method === 'chat.update' && c.args.ts === card.messageTs).at(-1);
    expect(frozen).toBeTruthy();
    expect(frozen!.args.blocks.some((b: any) => b.type === 'actions')).toBe(false); // no Stop all button
    // A finished plan (collapsed by Slack to its title), every run still listed.
    expect(frozen!.args.blocks[0]).toMatchObject({ type: 'plan', block_id: `card_${cardId}_plan` });
    expect(frozen!.args.blocks[0].tasks.filter((t: any) => t.task_id.startsWith('run_'))).toHaveLength(done.length);
    expect(frozen!.args.blocks[0].tasks.every((t: any) => t.status === 'complete' || t.status === 'error')).toBe(true);
    expect(frozen!.args.blocks.filter((b: any) => b.type === 'plan' || b.block_id === `card_${cardId}_plan`)).toHaveLength(1);
    const [card2] = await sql<any[]>`select * from cards where id = ${cardId}`;
    expect(card2.frozen).toBe(true);
    expect(card2.synthesized).toBe(true);
    const reported = await sql<any[]>`select reported from runs where card_id = ${cardId}`;
    expect(reported.every((r) => r.reported)).toBe(true);
    const events = await sql<any[]>`select type, payload from thread_events where thread_id = ${threadId} order by id`;
    expect(events.filter((e) => e.type === 'reply').length).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log('card title:', frozen!.args.blocks[0].title, '| in reply:', replied, '| synthesis:', streamed.slice(0, 200));
  }, 180_000);

  async function freshThread(tag: string) {
    const ts = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const id = `C_${tag}:${ts}`;
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${id}, ${`C_${tag}`}, ${ts}, true)`;
    return { id, ts };
  }

  async function runningSubagent(tid: string, owner: string, title: string) {
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, status) values (${tid}, ${owner}, 'done') returning id`;
    const { ensureTurnCard } = await import('./cards.js');
    const cardId = await ensureTurnCard({ threadId: tid, turnId: Number(t.id) });
    const saId = `sa_t${Math.random().toString(36).slice(2, 7)}`;
    await sql`insert into subagents (id, thread_id, owner_id, title, status) values (${saId}, ${tid}, ${owner}, ${title}, 'running')`;
    const [r] = await sql<any[]>`insert into runs (subagent_id, thread_id, card_id, turn_id, instructions, status, details, heartbeat_at, started_at)
      values (${saId}, ${tid}, ${cardId}, ${t.id}, 'Research the best laptops under $800 for programming', 'running', 'Searching the web for “laptops under 800”', now(), now()) returning id`;
    return { saId, runId: Number(r.id), cardId };
  }

  it('steers a running subagent and posts (not streams) while runs are active', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('STEER');
    const { saId, runId } = await runningSubagent(th.id, user, 'Laptops under $800');
    const msgTs = `${Number(th.ts) + 5}.000100`;
    threadText.set(th.id, {
      history: `<@${user}> Tester: @Smasnug find me the best laptops under $800 for programming\n[bot] Smasnug: On it.`,
      newMessages: `<@${user}> Tester: @Smasnug oh and they need to have at least 16GB of RAM`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${user}, true, ${[msgTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io());
    const inbox = await sql<any[]>`select text from subagent_inbox where subagent_id = ${saId}`;
    expect(inbox.length).toBe(1);
    expect(inbox[0].text).toMatch(/16/);
    const [run] = await sql<any[]>`select steer_notes from runs where id = ${runId}`;
    expect(run.steerNotes.length).toBe(1);
    expect(await sql`select * from cards where turn_id = ${t.id}`).toHaveLength(0);
    const calls = (await fakeCalls()).slice(before);
    expect(calls.map((c) => c.method)).not.toContain('chat.startStream');
    // eslint-disable-next-line no-console
    console.log('steer note:', run.steerNotes, '| calls:', calls.map((c) => `${c.method} ${c.args.text ?? ''}`.slice(0, 120)));
  }, 90_000);

  it('"stop" cancels the speaker\'s subagent and stays quiet', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('STOP');
    const { saId, runId } = await runningSubagent(th.id, user, 'Laptops under $800');
    threadText.set(th.id, {
      history: `<@${user}> Tester: @Smasnug find me the best laptops under $800 for programming`,
      newMessages: `<@${user}> Tester: @Smasnug stop, never mind`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${user}, true, ${[`${Number(th.ts) + 9}.000200`]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io());
    const [run] = await sql<any[]>`select cancel_requested from runs where id = ${runId}`;
    expect(run.cancelRequested).toBe(true);
    const calls = (await fakeCalls()).slice(before);
    const posts = calls.filter((c) => ['chat.postMessage', 'chat.startStream'].includes(c.method));
    // eslint-disable-next-line no-console
    console.log('stop posts:', posts.map((c) => c.args.text ?? streamArgsText(c.args)));
    expect(posts.length).toBeLessThanOrEqual(1);
    void saId;
  }, 90_000);

  it('a bare ping does not answer someone else\'s message from the channel background', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('PING');
    const pingTs = th.ts;
    const ch = th.id.split(':')[0]!;
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${ch}, ${th.ts}, ${th.id}, ${user}, ${'<@UBOT>'}) on conflict do nothing`;
    threadText.set(th.id, {
      history: '',
      channelContext: `[${Number(th.ts) - 60}.000100] <@U_SAM> Sam: how do i make a basic html page? like what's the starter code\n[${Number(th.ts) - 30}.000100] <@U_SAM> Sam: :rac_woah:`,
      newMessages: `[${th.ts}] <@${user}> Tester: <@UBOT>`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${user}, true, ${[pingTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(true));
    const posts = (await fakeCalls()).slice(before).filter((c) => ['chat.postMessage', 'chat.startStream', 'chat.appendStream'].includes(c.method));
    const text = posts.map((c) => c.args.text ?? streamArgsText(c.args)).join('');
    // eslint-disable-next-line no-console
    console.log('ping reply:', text);
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).not.toMatch(/<!doctype|<html|```/);
  }, 60_000);

  it('example HTML reaches Slack exactly as written: code as rich_text preformatted, never in markdown', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('HTML');
    threadText.set(th.id, { history: '', newMessages: `[${th.ts}] <@${user}> Tester: @Smasnug give me a tiny example html page with an h1 that says Hello, world! just the code block` });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${user}, true, ${[th.ts]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(true));
    const calls = (await fakeCalls()).slice(before).filter((c) => c.args?.channel === th.id.split(':')[0]);
    const out = calls.filter((c) => ['chat.postMessage', 'chat.startStream', 'chat.appendStream', 'chat.update'].includes(c.method));
    const blocks = out.flatMap((c) => [...(c.args.blocks ?? []), ...(c.args.chunks ?? []).flatMap((k: any) => k.blocks ?? [])]);
    const code = blocks.flatMap((b: any) => (b.type === 'rich_text' ? b.elements : [])).filter((e: any) => e.type === 'rich_text_preformatted');
    // eslint-disable-next-line no-console
    console.log('html reply code:', JSON.stringify(code.map((e: any) => ({ language: e.language, text: e.elements.map((x: any) => x.text).join('') }))));
    expect(code.length).toBeGreaterThan(0);
    expect(code.every((e: any) => typeof e.language === 'string' && e.language.length > 0)).toBe(true);
    expect(code.some((e: any) => /<h1>\s*Hello, world!\s*<\/h1>/i.test(e.elements.map((x: any) => x.text).join('')))).toBe(true);
    // No affected tag ever goes out inside markdown (Slack would rewrite it).
    const md = [...out.map((c) => streamArgsText(c.args)), ...blocks.filter((b: any) => b.type === 'markdown').map((b: any) => b.text)].join('\n');
    expect(md).not.toMatch(/<\/?(h[1-6]|code|img)\b/i);
  }, 60_000);

  it('unmentioned chatter between people stays silent (no fallback)', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('QUIET');
    threadText.set(th.id, {
      history: `<@U_SAM> Sam: @Smasnug what's the deadline for the hackathon signup?\n[bot] Smasnug: It's Friday at 5pm.\n<@U_SAM> Sam: thanks!`,
      newMessages: `<@${user}> Tester: <@U_SAM> are you bringing the extension cords tomorrow?`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${user}, false, ${[`${Number(th.ts) + 3}.000300`]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(false));
    const calls = (await fakeCalls()).slice(before).filter((c) => c.args.channel === th.id.split(':')[0]);
    const posts = calls.filter((c) => ['chat.postMessage', 'chat.startStream'].includes(c.method));
    // eslint-disable-next-line no-console
    if (posts.length) console.log('chatter posts:', posts.map((c) => c.args.text ?? streamArgsText(c.args)));
    expect(posts).toHaveLength(0);
  }, 60_000);

  it('a subagent can use web search (Exa client tool) and reports with sources', async () => {
    const { spawnSubagent } = await import('./subagents.js');
    const { processSubagentRun } = await import('./child.js');
    const th = await freshThread('WEB');
    const owner = `${user}W`; // own owner: other tests leave runs active, which count towards the per-user limit
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, status) values (${th.id}, ${owner}, 'running') returning id`;
    const s = await spawnSubagent({
      threadId: th.id,
      turnId: Number(t.id),
      ownerId: owner,
      title: 'Node LTS version',
      instructions: 'Use one web search to find the current Node.js LTS major version. Report the version and the source URL.',
    });
    await processSubagentRun(s.runId);
    const [run] = await sql<any[]>`select status, result, output, error, tokens, sources from runs where id = ${s.runId}`;
    // eslint-disable-next-line no-console
    console.log('web run:', run.status, run.output, run.tokens, JSON.stringify(run.sources), String(run.result).slice(0, 300));
    expect(run.status).toBe('complete');
    expect(run.result).toMatch(/https?:\/\//);
    // The URLs it used are stored for the card's sources.
    expect(run.sources.length).toBeGreaterThan(0);
    expect(run.sources[0].url).toMatch(/^https?:\/\//);
    // web_search is a client tool now: a real tool call, shown on the card as progress.
    const ev = await sql<any[]>`select type, payload from thread_events where thread_id = ${th.id} and type in ('run_step', 'run_progress') order by id`;
    const tools = ev.filter((e) => e.type === 'run_step').flatMap((e) => e.payload.tools ?? []);
    console.log('web run steps:', JSON.stringify(ev.map((e) => e.payload.details ?? e.payload.tools)));
    expect(tools).toContain('web_search');
    expect(ev.some((e) => e.type === 'run_progress' && String(e.payload.details).startsWith('Searching the web for'))).toBe(true);
  }, 120_000);

  // ---- Behaviour (the real-Slack incident replayed): decisive delegation, rare reactions. ----

  async function dmTurn(tag: string, history: string, text: string) {
    const ts = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const tid = `D_${tag}${Math.random().toString(36).slice(2, 6).toUpperCase()}:${ts}`;
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${tid}, ${tid.split(':')[0]!}, ${ts}, true)`;
    const msgTs = `${Number(ts) + 30}.000100`;
    // Own speaker per test: other tests leave subagents "running" (no worker), which count towards the user limit.
    const speaker = `${user}${tag}`;
    threadText.set(tid, { history: history.replaceAll(user, speaker), newMessages: `[${msgTs}] <@${speaker}> Tester: ${text}` });
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${tid}, ${speaker}, true, ${[msgTs]}, 'running') returning *`;
    return { tid, turn: { ...t, id: Number(t.id) } };
  }

  async function outcome(tid: string, before: number) {
    const calls = (await fakeCalls()).slice(before).filter((c) => (c.args.channel ?? '') === tid.split(':')[0]);
    const events = await sql<any[]>`select type, payload from thread_events where thread_id = ${tid} order by id`;
    const replies = events.filter((e) => e.type === 'reply' && !e.payload.fallback && !e.payload.stopped);
    const cards = await sql<any[]>`select title from cards where thread_id = ${tid}`;
    return {
      replies: replies.map((e) => String(e.payload.text)),
      reactionsAdded: calls.filter((c) => c.method === 'reactions.add').length,
      reactionsLeft: calls.filter((c) => c.method === 'reactions.add').length - calls.filter((c) => c.method === 'reactions.remove').length,
      spawns: events.filter((e) => e.type === 'spawn').length,
      cancels: events.filter((e) => e.type === 'cancel').length,
      dropped: events.filter((e) => e.type === 'reply_dropped').map((e) => e.payload.reason),
      cardTitles: cards.map((c) => c.title),
    };
  }

  it('the Pico research request delegates once: one spawn call, at most one ack, no reaction, no cancel', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn(
      'PICO',
      '',
      'can you research what the latest Raspberry Pi Pico model is and how it compares to the original Pico? take your time',
    );
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    // eslint-disable-next-line no-console
    const spawnCalls = (await turnToolNames(tid)).filter((t) => t === 'spawn_subagent').length;
    console.log('pico:', JSON.stringify({ ...o, spawnCalls }));
    // One call; one task, or two (the latest model and the original researched side by side, compared on return).
    expect(spawnCalls).toBe(1);
    expect(o.spawns).toBeGreaterThanOrEqual(1);
    expect(o.spawns).toBeLessThanOrEqual(2);
    expect(o.replies.length).toBeLessThanOrEqual(1);
    expect(o.reactionsAdded).toBe(0);
    expect(o.cancels).toBe(0);
    expect(o.cardTitles.every((t) => t == null)).toBe(true); // a user turn never titles its card (titles come after the write-up)
  }, 120_000);

  it('comparing three named, independent things fans out: one spawn_subagent call with a task per item', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn(
      'FANOUT',
      '',
      'can you compare Astro, SvelteKit and Remix for me? current version, build speed, learning curve and hosting options. take your time',
    );
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    const [tools] = await sql<{ payload: { calls: { tool: string }[] } }[]>`
      select payload from thread_events where thread_id = ${tid} and type = 'turn_tools' order by id desc limit 1`;
    const spawnCalls = (tools?.payload.calls ?? []).filter((c) => c.tool === 'spawn_subagent').length;
    // eslint-disable-next-line no-console
    console.log('fanout:', JSON.stringify({ ...o, spawnCalls }));
    expect(spawnCalls).toBe(1);
    expect(o.spawns).toBeGreaterThanOrEqual(3);
    expect(o.cancels).toBe(0);
  }, 120_000);

  it('"hi! what can you do?" gets one reply and no reaction', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn('HI', '', 'hi! what can you do?');
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    // eslint-disable-next-line no-console
    console.log('hi:', JSON.stringify(o));
    expect(o.replies).toHaveLength(1);
    expect(o.reactionsAdded).toBe(0);
    expect(o.spawns).toBe(0);
  }, 90_000);

  it('a reply ends the turn in its own model step (no end_turn step)', async () => {
    const { runFrontTurn } = await import('./front.js');
    const { TurnTiming } = await import('../core/timing.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn('STEP', '', 'yo whats 7 times 8');
    const timing = new TurnTiming();
    await runFrontTurn(turn, { ...io(), timing });
    const o = await outcome(tid, before);
    // eslint-disable-next-line no-console
    console.log('one step:', JSON.stringify(o), JSON.stringify(timing.notes.step_tools));
    expect(o.replies).toHaveLength(1);
    expect(timing.counters.model_steps).toBe(1);
    expect((timing.notes.step_tools as string[][])[0]).toContain('reply');
  }, 90_000);

  it('a two-party follow-up framed as talking with the bot gets an answer, not silence', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('TWOPARTY');
    const ch = th.id.split(':')[0]!;
    const speaker = `${user}TP`;
    threadText.set(th.id, {
      history: `[${th.ts}] <@${speaker}> Tester: <@UBOT> what's a good free tool for 3d modelling?\n[${Number(th.ts) + 5}.000100] [bot] smasnug ai (you): blender, no contest. free, runs everywhere, tons of tutorials (start with the donut one).`,
      newMessages: `[${Number(th.ts) + 60}.000100] <@${speaker}> Tester: does it run on a chromebook tho`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, addressed, message_ts, status) values (${th.id}, ${speaker}, false, true, ${[`${Number(th.ts) + 60}.000100`]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(false));
    const calls = (await fakeCalls()).slice(before).filter((c) => c.args?.channel === ch);
    const events = await sql<any[]>`select type from thread_events where thread_id = ${th.id} and type in ('reply', 'spawn')`;
    // eslint-disable-next-line no-console
    console.log('two-party:', calls.filter((c) => ['chat.postMessage', 'chat.startStream', 'chat.appendStream'].includes(c.method)).map((c) => c.args.text ?? streamArgsText(c.args)).join(''));
    expect(events.length).toBeGreaterThan(0);
  }, 120_000);

  it('"thanks!" after an answer gets a reaction only, no reply', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn(
      'THX',
      `[1790000000.000100] <@${user}> Tester: what's the default GPIO voltage on a Raspberry Pi Pico?\n[1790000005.000100] [bot] smasnug ai (you): The Pico's GPIO runs at 3.3V — don't feed 5V into the pins directly.`,
      'thanks!',
    );
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    // eslint-disable-next-line no-console
    console.log('thanks:', JSON.stringify(o));
    expect(o.replies).toHaveLength(0);
    expect(o.reactionsAdded).toBe(1);
    expect(o.spawns).toBe(0);
  }, 90_000);
  // ---- The Haven Canberra incident: a search hit with dates was a reply in a thread about ANOTHER game jam. ----

  /** True when every line mentioning October dates also makes clear they're not Haven's. */
  function octoberOnlyAsOtherJam(text: string): boolean {
    return text
      .split('\n')
      .filter((l) => /\b(oct(ober)?|2nd)\b/i.test(l))
      .every((l) => /cssa|anu comp|different|another|other (game )?jam|unrelated|not (ours|haven|the haven|oct)|isn['’]t|wasn['’]t|mix|confus|wrong|separate/i.test(l));
  }

  it('Haven Canberra: the subagent opens the thread behind a reply hit and does not report the other jam\'s dates', async () => {
    const { spawnSubagent } = await import('./subagents.js');
    const { processSubagentRun } = await import('./child.js');
    const { addFakeHandler } = await import('../core/slack-fake.js');
    const { havenFixtureHandler, HAVEN } = await import('../context/fixtures.js');
    const replies: { token: string; ts: string }[] = [];
    const off = addFakeHandler(havenFixtureHandler({ onRepliesCall: (token, args) => replies.push({ token, ts: String(args.ts) }) }));
    try {
      const th = await freshThread('HAVEN');
      const owner = `${user}H${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      const [t] = await sql<any[]>`insert into turns (thread_id, author_id, status) values (${th.id}, ${owner}, 'running') returning id`;
      const before = (await fakeCalls()).length;
      const s = await spawnSubagent({
        threadId: th.id,
        turnId: Number(t.id),
        ownerId: owner,
        title: 'Haven Canberra status',
        instructions:
          "The user asked: \"what's the state of haven canberra?\". Haven Canberra is an event organised in this Hack Club Slack. Search Slack for its current state: dates, venue, what's confirmed. Report what you find with sources.",
      });
      await processSubagentRun(s.runId);
      const [run] = await sql<any[]>`select status, result, error from runs where id = ${s.runId}`;
      const calls = (await fakeCalls()).slice(before);
      const tools = calls.filter((c) => c.method === 'search.messages' || c.method === 'conversations.replies').map((c) => `${c.method}(${(c as any).token}) ${c.args.query ?? c.args.ts ?? ''}`);
      // eslint-disable-next-line no-console
      console.log('haven calls:', tools, '\nhaven result:', run.result);
      expect(run.status).toBe('complete');
      expect(replies.some((r) => r.token === 'user' && r.ts === HAVEN.rootTs)).toBe(true); // read the thread
      expect(run.result).toMatch(/nov/i);
      expect(run.result).toMatch(/14/);
      expect(octoberOnlyAsOtherJam(run.result)).toBe(true);
    } finally {
      off();
    }
  }, 180_000);

  it('a correction on the same topic continues the existing subagent (message_subagent), no new spawn', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const history =
      `[1790000000.000100] <@${user}> Tester: what's the state of haven canberra?\n` +
      `[1790000040.000100] [bot] smasnug ai (you): haven canberra is fri 2 oct to sun 4 oct at the CSIT building at ANU, per #haven-canberra-bts`;
    const { tid, turn } = await dmTurn('HVNFIX', history, "that's another game jam, not haven. find the actual dates");
    const saId = `sa_hv${Math.random().toString(36).slice(2, 7)}`;
    await sql`insert into subagents (id, thread_id, owner_id, title, status, summary, history)
      values (${saId}, ${tid}, ${turn.authorId}, 'Haven Canberra status', 'idle', 'Haven Canberra: Oct 2-4 at ANU CSIT (from a thread reply in #haven-canberra-bts)',
        ${sql.json([{ role: 'user', content: "Find the current state of Haven Canberra in Slack." }, { role: 'assistant', content: 'Haven Canberra runs Fri 2 Oct to Sun 4 Oct at ANU CSIT (from a reply in #haven-canberra-bts).\nSUMMARY: Haven Canberra: Oct 2-4 at ANU CSIT' }])})`;
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    const events = await sql<any[]>`select type, payload from thread_events where thread_id = ${tid} and type in ('resume', 'steer') order by id`;
    // eslint-disable-next-line no-console
    console.log('haven follow-up:', JSON.stringify(o), JSON.stringify(events.map((e) => [e.type, e.payload.subagentId, String(e.payload.text).slice(0, 200)])));
    expect(o.spawns).toBe(0);
    expect(events.some((e) => e.payload.subagentId === saId)).toBe(true);
    expect(o.replies.length).toBeLessThanOrEqual(1);
  }, 120_000);
  it('"build me a page" posts an HTML file through reply(files)', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn('PAGE', '', 'build me a tiny one-file HTML page for my robotics club "Gearheads" (a heading and one paragraph). Just the file please.');
    await runFrontTurn(turn, io());
    const channelId = tid.split(':')[0]!;
    const calls = (await fakeCalls()).slice(before);
    const complete = calls.filter((c) => c.method === 'files.completeUploadExternal' && c.args.channel_id === channelId);
    const files = await sql<any[]>`select id, name, mime, description, owner_id from files where thread_id = ${tid}`;
    console.log('page:', JSON.stringify(complete.map((c) => c.args.files)), JSON.stringify(files));
    expect(complete).toHaveLength(1);
    expect(complete[0]!.args.files[0].title).toMatch(/\.html?$/);
    expect(files.some((f) => f.mime === 'text/html' && f.ownerId === turn.authorId)).toBe(true);
    await sql`delete from files where thread_id = ${tid}`;
  }, 120_000);

  /** Files the bot posted into a thread's channel since `before` (files.completeUploadExternal). */
  async function postedFiles(tid: string, before: number) {
    const channelId = tid.split(':')[0]!;
    return (await fakeCalls()).slice(before).filter((c) => c.method === 'files.completeUploadExternal' && c.args.channel_id === channelId);
  }

  it('"@bot ^" after the speaker\'s own unanswered request does that request (no "what do you need?")', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('CARET');
    const ch = th.id.split(':')[0]!;
    const speaker = `${user}CR`;
    const askTs = `${Number(th.ts) + 1}.000100`;
    const pingTs = `${Number(th.ts) + 90}.000100`;
    const ask = '<@UBOT> make me a tiny one-file HTML page for my chess club "Knight Owls": a heading and one sentence about meeting on thursdays';
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${ch}, ${askTs}, ${th.id}, ${speaker}, ${ask}), (${ch}, ${pingTs}, ${th.id}, ${speaker}, ${'<@UBOT> ^'})`;
    threadText.set(th.id, { history: `[${askTs}] <@${speaker}> Tester: ${ask}`, newMessages: `[${pingTs}] <@${speaker}> Tester: <@UBOT> ^` });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${speaker}, true, ${[pingTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(true));
    const o = await outcome(th.id, before);
    const files = await postedFiles(th.id, before);
    // eslint-disable-next-line no-console
    console.log('caret ping:', JSON.stringify(o), JSON.stringify(files.map((c) => c.args.files)));
    expect(files.length + o.spawns).toBeGreaterThan(0); // built it (or delegated building it), didn't just ask
    await sql`delete from files where thread_id = ${th.id}`;
  }, 120_000);

  it('a go-ahead ("yes make it") to the bot\'s own offer is acted on, not re-confirmed', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('GOAHEAD');
    const speaker = `${user}GA`;
    const goTs = `${Number(th.ts) + 120}.000100`;
    threadText.set(th.id, {
      history:
        `[${th.ts}] <@${speaker}> Tester: <@UBOT> my robotics club "Gearheads" needs a simple landing page, we meet tuesdays in room 4b\n` +
        `[${Number(th.ts) + 20}.000100] [bot] smasnug ai (you): nice. i can make you a single index.html with a heading, a line about tuesdays in room 4b and a simple dark theme. want me to make it?`,
      newMessages: `[${goTs}] <@${speaker}> Tester: yes make it`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, addressed, message_ts, status) values (${th.id}, ${speaker}, false, true, ${[goTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(false));
    const o = await outcome(th.id, before);
    const files = await postedFiles(th.id, before);
    // eslint-disable-next-line no-console
    console.log('go-ahead:', JSON.stringify(o), JSON.stringify(files.map((c) => c.args.files)));
    expect(files.length + o.spawns).toBeGreaterThan(0);
    expect(o.replies.join(' ')).not.toMatch(/want me to|should i|shall i/i);
    await sql`delete from files where thread_id = ${th.id}`;
  }, 120_000);

  /** The tool names a thread's latest turn called (turn_tools event). */
  async function turnToolNames(tid: string): Promise<string[]> {
    const [ev] = await sql<{ payload: { calls: { tool: string; args: string }[] } }[]>`
      select payload from thread_events where thread_id = ${tid} and type = 'turn_tools' order by id desc limit 1`;
    return (ev?.payload.calls ?? []).map((c) => c.tool);
  }

  it('a landing page for a user without sandbox access is written with create_file and posted (no giving up)', async () => {
    const { runFrontTurn } = await import('./front.js');
    sandboxAccess.deny = true;
    try {
      const before = (await fakeCalls()).length;
      const { tid, turn } = await dmTurn('LANDING', '', 'build me a landing page for my hackathon team "Byte Brigade": a hero section, a short about-us and a sign-up button');
      await runFrontTurn(turn, io());
      const o = await outcome(tid, before);
      const files = await postedFiles(tid, before);
      // eslint-disable-next-line no-console
      console.log('landing (no sandbox):', JSON.stringify(o), JSON.stringify(await turnToolNames(tid)), JSON.stringify(files.map((c) => c.args.files)));
      expect(files.some((c) => /\.html?$/.test(String(c.args.files?.[0]?.title ?? '')))).toBe(true);
      expect(o.replies.join(' ')).not.toMatch(/can.?t build|not available|unable to/i);
      await sql`delete from files where thread_id = ${tid}`;
    } finally {
      sandboxAccess.deny = false;
    }
  }, 180_000);

  it('"@bot ^" under a teammate\'s request does that request for them (one speaker is not "only their own requests")', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('TEAMCARET');
    const ch = th.id.split(':')[0]!;
    const speaker = `${user}TC`;
    const mate = `${user}MATE`;
    const askTs = `${Number(th.ts) + 1}.000100`;
    const pingTs = `${Number(th.ts) + 60}.000100`;
    const ask = 'could someone make a tiny one-file HTML page for our robotics club "Gearheads"? just a heading and a line saying we meet tuesdays in room 4b';
    await sql`insert into messages (channel_id, ts, thread_id, user_id, text) values (${ch}, ${askTs}, ${th.id}, ${mate}, ${ask}), (${ch}, ${pingTs}, ${th.id}, ${speaker}, ${'<@UBOT> ^'})`;
    threadText.set(th.id, { history: `[${askTs}] <@${mate}> Sam: ${ask}`, newMessages: `[${pingTs}] <@${speaker}> Tester: <@UBOT> ^` });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${speaker}, true, ${[pingTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(true));
    const o = await outcome(th.id, before);
    const files = await postedFiles(th.id, before);
    // eslint-disable-next-line no-console
    console.log('teammate caret:', JSON.stringify(o), JSON.stringify(files.map((c) => c.args.files)));
    expect(files.length + o.spawns).toBeGreaterThan(0);
    expect(o.replies.join(' ')).not.toMatch(/only (act|help) for|on (their|sam'?s) behalf|ask (them|sam) to/i);
    await sql`delete from files where thread_id = ${th.id}`;
  }, 120_000);

  it('a correction ("wait, I meant…") to a page the bot just made is acted on in the same turn', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('CORRECT');
    const speaker = `${user}CO`;
    const fixTs = `${Number(th.ts) + 120}.000100`;
    threadText.set(th.id, {
      history:
        `[${th.ts}] <@${speaker}> Tester: <@UBOT> make me a one-file HTML page for my chess club: a heading and a line that we meet on thursdays\n` +
        `[${Number(th.ts) + 20}.000100] [bot] smasnug ai (you): here you go: a heading "Chess Club" and a line about thursdays. [file file_abc123: chess-club.html, html page, from smasnug ai — "Chess club page"]`,
      newMessages: `[${fixTs}] <@${speaker}> Tester: wait, i meant fridays, and the club is called "Knight Owls"`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, addressed, message_ts, status) values (${th.id}, ${speaker}, false, true, ${[fixTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(false));
    const o = await outcome(th.id, before);
    const files = await postedFiles(th.id, before);
    // eslint-disable-next-line no-console
    console.log('correction:', JSON.stringify(o), JSON.stringify(files.map((c) => c.args.files)));
    expect(files.length + o.spawns).toBeGreaterThan(0);
    expect(o.replies.join(' ')).not.toMatch(/want me to|should i|shall i/i);
    await sql`delete from files where thread_id = ${th.id}`;
  }, 120_000);

  it('an explicit length ("a 300-word explainer") beats the brevity default: ≥ ~270 words in the reply, a canvas or a file', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn(
      'LENGTH',
      '',
      'write me a 300-word explainer on glimmerball, a sport i invented for my novel: teams of four on floating platforms try to catch a glowing ball that changes weight. make up the details',
    );
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    const channelId = tid.split(':')[0]!;
    const canvases = (await fakeCalls())
      .slice(before)
      .filter((c) => c.method === 'canvases.create' || c.method === 'canvases.edit')
      .map((c) => JSON.stringify(c.args));
    const files = await sql<{ content: Buffer | null }[]>`select content from files where thread_id = ${tid} and channel_id = ${channelId}`;
    const words = (s: string) => s.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
    const counts = [...o.replies, ...canvases, ...files.map((f) => f.content?.toString('utf8') ?? '')].map(words);
    // eslint-disable-next-line no-console
    console.log('length:', JSON.stringify({ replies: o.replies.map(words), canvases: canvases.length, files: files.length, spawns: o.spawns, counts }));
    expect(Math.max(0, ...counts)).toBeGreaterThanOrEqual(270);
    await sql`delete from files where thread_id = ${tid}`;
  }, 120_000);

  it('per-section minimums ("each part at least 200 words") are met, not squeezed into a few lines per part', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn(
      'SECTIONS',
      '',
      'for my novel, write a 3-part guide to glimmerball (a sport i invented: teams of four on floating platforms catch a glowing ball that changes weight): rules, positions, strategy. each part at least 200 words. make up the details',
    );
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    const channelId = tid.split(':')[0]!;
    const canvases = (await fakeCalls())
      .slice(before)
      .filter((c) => c.method === 'canvases.create' || c.method === 'canvases.edit')
      .map((c) => JSON.stringify(c.args));
    const files = await sql<{ content: Buffer | null }[]>`select content from files where thread_id = ${tid} and channel_id = ${channelId}`;
    const words = (s: string) => s.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
    const total = [...o.replies, ...canvases, ...files.map((f) => f.content?.toString('utf8') ?? '')].map(words).reduce((a, b) => a + b, 0);
    // eslint-disable-next-line no-console
    console.log('sections:', JSON.stringify({ replies: o.replies.map(words), canvases: canvases.length, files: files.length, spawns: o.spawns, total }));
    expect(total).toBeGreaterThanOrEqual(560);
    await sql`delete from files where thread_id = ${tid}`;
  }, 180_000);

  it('comparing three named libraries fans out too: one spawn_subagent call with a task per library', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn('LIBS', '', 'zustand vs jotai vs redux toolkit for a mid-size react app? compare bundle size, API style, devtools and how actively each is maintained');
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    const spawnCalls = (await turnToolNames(tid)).filter((t) => t === 'spawn_subagent').length;
    // eslint-disable-next-line no-console
    console.log('libs:', JSON.stringify({ spawns: o.spawns, spawnCalls }));
    expect(spawnCalls).toBe(1);
    expect(o.spawns).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('"what can you do" mentions running code when sandboxes are configured', async () => {
    const { sandboxConfigured } = await import('../sandbox/settings.js');
    if (!sandboxConfigured()) return;
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    const { tid, turn } = await dmTurn('CAPS', '', 'what all can you do?');
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    // eslint-disable-next-line no-console
    console.log('caps:', JSON.stringify(o.replies));
    expect(o.replies.join(' ')).toMatch(/run(ning)? (code|python|scripts)|sandbox|execute/i);
  }, 90_000);

  it('a capability that is not available here is declined plainly, without setup questions', async () => {
    const { runFrontTurn } = await import('./front.js');
    const before = (await fakeCalls()).length;
    // Not the admin: coding agents aren't offered to this speaker.
    const { tid, turn } = await dmTurn('NOCAP', '', 'can you spin up a coding agent to open a PR on your own code that makes your replies shorter?');
    await runFrontTurn(turn, io());
    const o = await outcome(tid, before);
    const tools = await turnToolNames(tid);
    // eslint-disable-next-line no-console
    console.log('no capability:', JSON.stringify(o.replies), JSON.stringify(tools));
    expect(tools).not.toContain('spawn_coding_agent');
    expect(o.replies.join(' ')).not.toMatch(/which repo|what repo|repo (url|link)|link (to )?(the|your) repo|github (url|link)/i);
  }, 90_000);

  it('an admin musing about the bot gets a brief acknowledgement, not a coding agent proposal', async () => {
    const { runFrontTurn } = await import('./front.js');
    const th = await freshThread('MUSE');
    const admin = 'U_LIVEADMIN';
    const msgTs = `${Number(th.ts) + 5}.000100`;
    threadText.set(th.id, {
      history: '',
      newMessages: `[${msgTs}] <@${admin}> Ingo: <@UBOT> hmm, your reminder confirmations should probably be shorter at some point`,
    });
    const before = (await fakeCalls()).length;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, is_mention, message_ts, status) values (${th.id}, ${admin}, true, ${[msgTs]}, 'running') returning *`;
    await runFrontTurn({ ...t, id: Number(t.id) }, io(true));
    const o = await outcome(th.id, before);
    const tools = await turnToolNames(th.id);
    // eslint-disable-next-line no-console
    console.log('admin musing:', JSON.stringify(o), JSON.stringify(tools));
    expect(tools).not.toContain('spawn_coding_agent');
    expect(o.replies.length + o.reactionsAdded).toBeGreaterThan(0);
  }, 120_000);

  it('an uploaded image in context is looked at with read_file / ask_file', async () => {
    const { runFrontTurn } = await import('./front.js');
    const { createFile } = await import('../files/store.js');
    const sharp = (await import('sharp')).default;
    const { tid, turn } = await dmTurn('IMG', '', 'placeholder');
    const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#1f9d55' } }).png().toBuffer();
    const f = await createFile({ threadId: tid, ownerId: turn.authorId, name: 'swatch.png', content: png, description: '' });
    const msgTs = turn.messageTs[0];
    threadText.set(tid, { history: '', newMessages: `[${msgTs}] <@${turn.authorId}> Tester: what colour is this? [file ${f.id}: swatch.png, image, from Tester]` });
    await runFrontTurn(turn, io());
    const tools = await sql<any[]>`select payload from thread_events where thread_id = ${tid} and type = 'turn_tools'`;
    const o = await outcome(tid, 0);
    console.log('image turn:', JSON.stringify(tools.map((t) => t.payload)), JSON.stringify(o.replies));
    expect(JSON.stringify(tools.map((t) => t.payload))).toMatch(/read_file|ask_file/);
    expect(o.replies.join(' ')).toMatch(/green/i);
    await sql`delete from files where thread_id = ${tid}`;
  }, 120_000);
});
