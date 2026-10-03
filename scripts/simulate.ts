/**
 * Local end-to-end simulation (SLACK_FAKE=1): injects synthetic Slack message envelopes onto the slack-events queue,
 * lets the worker process them, then prints the fake Slack calls, turns and thread events.
 *
 *   pnpm simulate                 # runs a worker in-process
 *   pnpm simulate --no-worker     # use an already running `SLACK_FAKE=1 pnpm dev:worker`
 *   pnpm simulate --wait 20       # seconds to wait before printing (default 12)
 *
 * The relevance gate is called live (OpenRouter) for the unmentioned multi-author follow-ups.
 */
process.env.SLACK_FAKE = '1';

const args = process.argv.slice(2);
const inProcessWorker = !args.includes('--no-worker');
const waitIdx = args.indexOf('--wait');
const waitSec = waitIdx >= 0 ? Number(args[waitIdx + 1]) : 12;

const { enqueue, QUEUE, closeQueues } = await import('../src/core/queues.js');
const { redis } = await import('../src/core/redis.js');
const { sql } = await import('../src/db/index.js');
const { fakeCalls } = await import('../src/core/slack-fake.js');
const { getBotIdentity } = await import('../src/core/slack.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const base = Math.floor(Date.now() / 1000);
const ts = () => `${base}.${String(++n).padStart(6, '0')}`;
const channel = `CSIM${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const dm = `DSIM${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

async function inject(event: Record<string, unknown>) {
  const body = { type: 'event_callback', event_id: `EvSim${Math.random().toString(36).slice(2, 10)}`, event: { type: 'message', channel, channel_type: 'channel', ...event } };
  await enqueue(QUEUE.slackEvents, { kind: 'event', body });
  console.log(`→ ${String(event.subtype ?? 'message').padEnd(16)} ${String(event.user ?? '').padEnd(4)} ${JSON.stringify(event.text ?? '')}`);
}

let stopWorker: (() => Promise<void>) | undefined;
if (inProcessWorker) {
  const { startWorker } = await import('../src/worker/main.js');
  const { workers } = await startWorker();
  stopWorker = async () => {
    await Promise.all(workers.map((w) => w.close(true)));
  };
}

await redis.del('slack:fake:calls');
const bot = await getBotIdentity();
const B = `<@${bot.userId}>`;

console.log(`\n== Scenario 1: mention, then follow-up by the same user (two-party → no gate) in ${channel}`);
const root = ts();
await inject({ user: 'U1', text: `${B} what's a good first hardware project?`, ts: root });
await sleep(300);
await inject({ user: 'U1', text: 'something with LEDs ideally', ts: ts(), thread_ts: root });
await sleep(2500);

console.log('\n== Scenario 2: two authors at once (separate batches, never merged; gated)');
await inject({ user: 'U2', text: 'have you tried the arduino starter kit?', ts: ts(), thread_ts: root });
await inject({ user: 'U3', text: 'what would you recommend for a 14 year old, bot?', ts: ts(), thread_ts: root });
await sleep(400);
await inject({ user: 'U3', text: 'budget is like $30', ts: ts(), thread_ts: root });

console.log('\n== Scenario 3: someone mentions another person (skipped), a bot message (stored only)');
await inject({ user: 'U2', text: '<@U9> you did this last year right?', ts: ts(), thread_ts: root });
await inject({ bot_id: 'BOTHER', username: 'otherbot', text: 'beep', ts: ts(), thread_ts: root });

console.log('\n== Scenario 4: DM, edited during the window');
const dmTs = ts();
await enqueue(QUEUE.slackEvents, { kind: 'event', body: { event_id: `EvSim${n}`, event: { type: 'message', channel: dm, channel_type: 'im', user: 'U4', text: 'remind me what you can do', ts: dmTs } } });
console.log(`→ message (DM)       U4   "remind me what you can do"`);
await enqueue(QUEUE.slackEvents, {
  kind: 'event',
  body: { event_id: `EvSim${n}e`, event: { type: 'message', subtype: 'message_changed', channel: dm, channel_type: 'im', message: { user: 'U4', text: 'remind me what you can do, briefly', ts: dmTs, edited: { ts: ts() } } } },
});
console.log(`→ message_changed    U4   "remind me what you can do, briefly"`);

console.log('\n== Scenario 5: agent container — user views a channel, DMs, then presses the native stop button');
await enqueue(QUEUE.slackEvents, {
  kind: 'event',
  body: { event_id: `EvSim${n}c`, authorizations: [{ user_id: 'U5' }], event: { type: 'app_context_changed', context: { entities: [{ type: 'slack#/types/channel_id', value: channel }] } } },
});
console.log(`→ app_context_changed U5   viewing ${channel}`);
const dm2 = `${dm}X`;
const dm2Ts = ts();
await enqueue(QUEUE.slackEvents, {
  kind: 'event',
  body: { event_id: `EvSim${n}d`, event: { type: 'message', channel: dm2, channel_type: 'im', user: 'U5', text: 'write me a detailed, long guide to soldering for beginners', ts: dm2Ts } },
});
console.log(`→ message (DM)       U5   "write me a detailed, long guide to soldering for beginners"`);
await sleep(3000);
await enqueue(QUEUE.slackEvents, {
  kind: 'event',
  body: { event_id: `EvSim${n}s`, event: { type: 'agent_session_stopped', channel: dm2, thread_ts: dm2Ts, user: 'U5', event_ts: ts(), streaming_message_ts: [] } },
});
console.log(`→ agent_session_stopped U5`);

console.log(`\n… waiting ${waitSec}s for debounce, gate and turns`);
await sleep(waitSec * 1000);

const calls = await fakeCalls();
console.log(`\n== Fake Slack calls (${calls.length})`);
for (const c of calls) {
  const a = c.args ?? {};
  console.log(`  ${c.method.padEnd(28)} ${JSON.stringify({ channel: a.channel ?? a.channel_id, thread_ts: a.thread_ts, text: a.text, status: a.status, initiator: a.initiator_user_id, markdown_text: a.markdown_text }).slice(0, 220)}`);
}

const turns = await sql`select id::int, thread_id, author_id, kind, is_mention, message_ts, status from turns where thread_id like ${channel + ':%'} or thread_id like ${dm + '%'} order by id`;
console.log(`\n== Turns (${turns.length})`);
for (const t of turns) console.log(`  #${t.id} ${t.threadId} author=${t.authorId} mention=${t.isMention} msgs=${t.messageTs.length} status=${t.status}`);

const events = await sql`select thread_id, type, actor, payload from thread_events where thread_id like ${channel + ':%'} or thread_id like ${dm + '%'} order by id`;
console.log(`\n== Thread events (${events.length})`);
for (const e of events) console.log(`  ${e.type.padEnd(16)} ${String(e.actor ?? '').padEnd(10)} ${JSON.stringify(e.payload).slice(0, 160)}`);

await stopWorker?.();
await closeQueues();
await redis.quit();
await sql.end({ timeout: 2 });
process.exit(0);
