/**
 * Latency benchmark: runs the real pipeline in-process (ingress handler → slack-events → debounce → thread-run →
 * front agent with the real OpenRouter models) against SLACK_FAKE Slack with artificial per-call latency, on the
 * bench database/Redis (`smasnug_bench`, Redis db 11 on the test servers; never the dev ones).
 *
 *   pnpm bench                                  # all single-thread scenarios, 3 runs each
 *   pnpm bench --runs 5 --only hi,search        # subset
 *   pnpm bench --parallel 8                     # also: 8 DMs/mentions in different threads at the same moment
 *   pnpm bench --latency 150 --jitter 50        # fake Slack latency per call (ms)
 *   pnpm bench --json out.json                  # dump raw results
 *
 * Every number is ms after the user's message (its Slack ts = when the bench injects it). Phase marks come from the
 * `turn_timing` event the pipeline writes at the end of each turn (src/core/timing.ts).
 */
import { applyBenchEnv } from '../src/testing/test-db.js';

const args = process.argv.slice(2);
const arg = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const RUNS = Number(arg('runs', '3'));
const ONLY = arg('only')?.split(',');
const PARALLEL = Number(arg('parallel', '0'));
const LATENCY = arg('latency', '150')!;
const JITTER = arg('jitter', '0')!;
const JSON_OUT = arg('json');

applyBenchEnv();
try {
  process.loadEnvFile('.env'); // OPENROUTER_KEY etc.; never overrides the DATABASE_URL/REDIS_URL set above
} catch {}
process.env.SLACK_FAKE_LATENCY_MS = LATENCY;
process.env.SLACK_FAKE_LATENCY_JITTER_MS = JITTER;
process.env.SLACK_FAKE_LIMITER = '1';
process.env.LOG_LEVEL = process.env.BENCH_LOG_LEVEL ?? 'warn';

// ---- infra: create + migrate the bench database, flush the bench Redis db ----
{
  const { default: postgres } = await import('postgres');
  const { Redis } = await import('ioredis');
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  if ((await admin`select 1 from pg_database where datname = ${dbName}`).length === 0) await admin.unsafe(`create database "${dbName}"`);
  await admin.end();
  const r = new Redis(process.env.REDIS_URL!);
  await r.flushdb();
  r.disconnect();
}

const { migrate } = await import('../src/db/migrate.js');
await migrate();
const { sql } = await import('../src/db/index.js');
await sql`truncate threads, messages, slack_events_seen, idempotency_keys, usage, user_memory cascade`;
const { redis } = await import('../src/core/redis.js');
const { closeQueues } = await import('../src/core/queues.js');
const { addFakeHandler } = await import('../src/core/slack-fake.js');
const { handleEnvelope } = await import('../src/ingress/main.js');
const { cancelThreadRuns } = await import('../src/agent/subagents.js');
const { startWorker } = await import('../src/worker/main.js');
const { workers } = await startWorker();

// ---- fake Slack content ----
const injected = new Map<string, any>(); // `${channel}:${ts}` → event
addFakeHandler((method, a) => {
  if (method === 'conversations.replies') {
    // A brand-new DM/mention thread: Slack returns the parent (= the message itself).
    const ev = injected.get(`${a.channel}:${a.ts}`);
    return { ok: true, messages: ev ? [{ type: 'message', user: ev.user, text: ev.text, ts: ev.ts }] : [], has_more: false };
  }
  if (method === 'search.messages') {
    const base = Math.floor(Date.now() / 1000) - 86400;
    const mk = (i: number, ch: string, user: string, text: string) => ({
      ts: `${base + i * 3600}.000100`,
      user,
      text,
      channel: { id: `C${ch.toUpperCase()}`, name: ch, is_channel: true },
      permalink: `https://fake.slack.com/archives/C${ch.toUpperCase()}/p${base + i * 3600}000100`,
    });
    return {
      ok: true,
      messages: {
        total: 4,
        matches: [
          mk(1, 'ship', 'UALICE', 'the hackathon venue is the old library on 5th, doors open 9am saturday'),
          mk(2, 'hackathon', 'UBOB', 'venue confirmed! we have the library basement + main hall, wifi is decent'),
          mk(3, 'ship', 'UCARA', 'shipped my led matrix project, demo at the venue on saturday'),
          mk(4, 'general', 'UDAN', 'is there parking at the hackathon venue? asking for my mom lol'),
        ],
      },
    };
  }
  if (method === 'conversations.info') return { ok: true, channel: { id: a.channel, name: 'ship', is_private: false, is_member: true, purpose: { value: 'show off what you shipped' } } };
  return undefined;
});

// ---- scenarios ----
interface Scenario {
  name: string;
  text: string;
  /** Behaviour check on the finished thread. */
  check?: (ev: { type: string; payload: any }[]) => string | null;
}
const replied = (evs: { type: string; payload: any }[]) => evs.some((e) => e.type === 'reply' && !e.payload?.fallback);
const SCENARIOS: Scenario[] = [
  { name: 'hi', text: 'hi! what can you do?', check: (e) => (replied(e) ? null : 'no reply') },
  { name: 'factual', text: "what's the difference between tcp and udp? keep it short", check: (e) => (replied(e) ? null : 'no reply') },
  {
    name: 'search',
    text: 'search slack for messages mentioning the hackathon venue and tell me what people said',
    check: (e) => (replied(e) ? null : 'no reply'),
  },
  { name: 'ship', text: "what's the #ship channel for?", check: (e) => (replied(e) ? null : 'no reply') },
  {
    name: 'research',
    text: 'can you research the best beginner microcontroller boards right now and compare prices across a few shops? take your time',
    check: (e) => (e.some((x) => x.type === 'spawn') ? null : 'did not spawn'),
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const newTs = () => `${Math.floor(Date.now() / 1000)}.${String((Date.now() % 1000) * 1000 + (++seq % 1000)).padStart(6, '0')}`;

async function inject(opts: { channel: string; user: string; text: string; dm: boolean }) {
  const ts = newTs();
  const event = { type: 'message', channel: opts.channel, channel_type: opts.dm ? 'im' : 'channel', user: opts.user, text: opts.text, ts, event_ts: ts };
  injected.set(`${opts.channel}:${ts}`, event);
  const body = { type: 'event_callback', event_id: `EvBench${Date.now()}${++seq}`, event_time: Math.floor(Date.now() / 1000), event };
  await handleEnvelope({ ack: async () => {}, envelope_id: `env-${seq}`, type: 'events_api', body } as any, Date.now());
  return { threadId: `${opts.channel}:${ts}`, ts };
}

interface Result {
  scenario: string;
  threadId: string;
  rel: Record<string, number>;
  spans: Record<string, number>;
  counters: Record<string, number>;
  notes?: Record<string, any>;
  headline: { firstStatusMs: number | null; firstTextMs: number | null; turnEndMs: number | null };
  problem: string | null;
}

/** thread_events payloads come back camelCased (postgres.camel); the timing names are snake_case. */
const snake = (o: Record<string, any> = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/([a-z])(\d)/g, '$1$2'), v]));

async function waitForTurn(threadId: string, timeoutMs = 120_000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [t] = await sql<any[]>`select payload from thread_events where thread_id = ${threadId} and type = 'turn_timing' and payload->>'kind' = 'user' order by id limit 1`;
    if (t) return t.payload;
    await sleep(100);
  }
  return null;
}

async function collect(scenario: Scenario | { name: string; check?: Scenario['check'] }, threadId: string, user: string): Promise<Result> {
  const p = await waitForTurn(threadId);
  const evs = await sql<{ type: string; payload: any }[]>`select type, payload from thread_events where thread_id = ${threadId} order by id`;
  // Subagent runs: how long they waited in the queue (parallelism check); then cancel them so they don't burn tokens.
  let runLag: number | undefined;
  if (evs.some((e) => e.type === 'spawn')) {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const rows = await sql<{ lag: number | null }[]>`select (extract(epoch from started_at - created_at) * 1000)::int as lag from runs where thread_id = ${threadId}`;
      if (rows.length && rows.every((r) => r.lag != null)) {
        runLag = Math.max(...rows.map((r) => r.lag!));
        break;
      }
      await sleep(50);
    }
  }
  await cancelThreadRuns(threadId, user).catch(() => {});
  if (!p) return { scenario: scenario.name, threadId, rel: {}, spans: {}, counters: {}, headline: { firstStatusMs: null, firstTextMs: null, turnEndMs: null }, problem: 'timeout' };
  const counters = snake(p.counters);
  if (runLag != null) counters.subagent_queue_ms = runLag;
  return { scenario: scenario.name, threadId, rel: snake(p.rel), spans: snake(p.spans), counters, notes: p.notes ?? {}, headline: p.headline, problem: scenario.check?.(evs) ?? null };
}

const results: Result[] = [];
const scenarios = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.name));
console.log(`bench: ${RUNS} run(s) × [${scenarios.map((s) => s.name).join(', ')}]${PARALLEL ? ` + parallel×${PARALLEL}` : ''}, fake Slack latency ${LATENCY}ms (+${JITTER} jitter)`);

// Warm-up (connections, caches, auth.test, model route) — not recorded.
{
  const { threadId } = await inject({ channel: 'DWARM', user: 'UWARM', text: 'yo', dm: true });
  await waitForTurn(threadId);
}

for (let run = 0; run < RUNS; run++) {
  for (const s of scenarios) {
    const user = `UB${s.name.toUpperCase().slice(0, 6)}`;
    const { threadId } = await inject({ channel: `D${user}`, user, text: s.text, dm: true });
    const r = await collect(s, threadId, user);
    results.push(r);
    console.log(`  ${s.name.padEnd(9)} run ${run + 1}: status ${fmt(r.headline.firstStatusMs)}  text ${fmt(r.headline.firstTextMs)}  end ${fmt(r.headline.turnEndMs)}  steps ${JSON.stringify(r.notes?.stepTools ?? [])}${r.problem ? `  !! ${r.problem}` : ''}`);
    await sleep(500);
  }
}

if (PARALLEL > 0) {
  for (let run = 0; run < RUNS; run++) {
    // Mix: 3 threads in one user's DM channel, the rest one DM channel per user, plus channel mentions.
    const jobs: { name: string; channel: string; user: string; dm: boolean; text: string }[] = [];
    for (let i = 0; i < PARALLEL; i++) {
      const sameDm = i < 3;
      const mention = !sameDm && i % 3 === 2;
      const user = sameDm ? 'UPARA0' : `UPARA${i}`;
      const research = !sameDm && i % 4 === 3;
      const text = research ? SCENARIOS.find((s) => s.name === 'research')!.text : SCENARIOS[i % 2]!.text;
      if (research) jobs.push({ name: 'par-research', channel: `D${user}`, user, dm: true, text });
      else if (mention) jobs.push({ name: `par-mention`, channel: 'CPARALLEL', user, dm: false, text: `<@UBOT> ${text}` });
      else jobs.push({ name: sameDm ? 'par-same-dm' : 'par-own-dm', channel: `D${user}`, user, dm: true, text });
    }
    const started = await Promise.all(jobs.map((j) => inject({ channel: j.channel, user: j.user, text: j.text, dm: j.dm })));
    const rs = await Promise.all(
      started.map((s, i) =>
        collect({ name: jobs[i]!.name, check: jobs[i]!.name === 'par-research' ? SCENARIOS.find((x) => x.name === 'research')!.check : (e) => (replied(e) ? null : 'no reply') }, s.threadId, jobs[i]!.user),
      ),
    );
    for (const r of rs) results.push({ ...r, scenario: `${r.scenario}` });
    const all = rs.map((r) => r.headline.firstTextMs ?? NaN);
    console.log(`  parallel run ${run + 1}: first text per thread ${rs.map((r) => fmt(r.headline.firstTextMs)).join(' ')}  (max ${fmt(Math.max(...all))})`);
    await sleep(1000);
  }
}

// ---- report ----
function fmt(v: number | null | undefined) {
  return v == null || Number.isNaN(v) ? '-' : `${(v / 1000).toFixed(2)}s`;
}
function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : Math.round((v[m - 1]! + v[m]!) / 2);
}
const groups = [...new Set(results.map((r) => r.scenario))];
const by = (g: string) => results.filter((r) => r.scenario === g && r.problem !== 'timeout');
function table(title: string, rows: string[], get: (r: Result, row: string) => number | undefined, unit: 'ms' | 'n' = 'ms') {
  const present = rows.filter((row) => groups.some((g) => by(g).some((r) => get(r, row) != null)));
  if (!present.length) return;
  console.log(`\n${title}`);
  console.log(['phase'.padEnd(22), ...groups.map((g) => g.padStart(12))].join(''));
  for (const row of present) {
    const cells = groups.map((g) => {
      const m = median(by(g).map((r) => get(r, row) ?? NaN));
      return (m == null ? '-' : unit === 'ms' ? String(m) : String(m)).padStart(12);
    });
    console.log([row.padEnd(22), ...cells].join(''));
  }
}
const { PHASES } = await import('../src/core/timing.js');
const phaseRows = [...new Set([...PHASES, ...results.flatMap((r) => Object.keys(r.rel))])];
console.log(`\n=== medians over ${RUNS} run(s), ms after the user's message ===`);
table('headline', ['first status', 'first text', 'turn end'], (r, row) =>
  (row === 'first status' ? r.headline.firstStatusMs : row === 'first text' ? r.headline.firstTextMs : r.headline.turnEndMs) ?? undefined,
);
table('phase marks (ms after message)', phaseRows, (r, row) => r.rel[row]);
table('spans (ms)', [...new Set(results.flatMap((r) => Object.keys(r.spans)))].sort(), (r, row) => r.spans[row]);
table('counters', [...new Set(results.flatMap((r) => Object.keys(r.counters)))].sort(), (r, row) => r.counters[row], 'n');
const problems = results.filter((r) => r.problem);
if (problems.length) console.log(`\nproblems: ${problems.map((p) => `${p.scenario}: ${p.problem}`).join('; ')}`);
if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(JSON_OUT, JSON.stringify({ runs: RUNS, latency: LATENCY, results }, null, 2));
}

await Promise.all(workers.map((w) => w.close(true)));
await closeQueues();
await redis.quit();
await sql.end({ timeout: 2 });
process.exit(0);
