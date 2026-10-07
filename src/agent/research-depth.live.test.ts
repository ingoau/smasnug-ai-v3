/**
 * Research depth (LIVE=1, real models, SLACK_FAKE Slack with invented data):
 * 1. A subagent follows a multi-hop lead: the first searches only find a reply in thread A; thread A names a codename;
 *    only a search for the codename finds thread B, and only B's replies hold the answer.
 * 2. A synthesis turn with partial results still answers every part (caveats per claim, the requested length), not a
 *    blanket refusal, and doesn't make up what no source says.
 *   LIVE=1 pnpm vitest run src/agent/research-depth.live.test.ts
 * All Slack content here is made up.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const LIVE = process.env.LIVE === '1';
if (LIVE) {
  try {
    process.loadEnvFile('.env');
  } catch {}
  process.env.SLACK_FAKE = '1';
  process.env.LOG_LEVEL ??= 'warn';
}

const threadText = new Map<string, { history: string; newMessages: string }>();
vi.mock('../context/thread.js', () => ({
  renderThreadContext: async (threadId: string) => ({ history: threadText.get(threadId)?.history ?? '', channelContext: '', newMessages: threadText.get(threadId)?.newMessages ?? '' }),
  renderMessages: async (_threadId: string, ts: string[]) => ts.map((t) => `<@U_TEST> Tester: (message ${t})`).join('\n'),
}));
vi.mock('../pipeline/scheduler.js', () => ({
  requestTurn: async (opts: any) => {
    const { sql } = await import('../db/index.js');
    const [row] = await sql<{ id: number }[]>`
      insert into turns (thread_id, author_id, kind, card_id, is_mention, message_ts)
      values (${opts.threadId}, ${opts.authorId}, ${opts.kind}, ${opts.cardId ?? null}, ${opts.isMention ?? false}, ${opts.messageTs ?? []}) returning id`;
    return Number(row!.id);
  },
}));

// ---------- Invented Slack data for the multi-hop scenario ----------
const LOUNGE = { id: 'C0RDLOUNGE', name: 'lounge' };
const BOTLAB = { id: 'C0RDBOTLAB', name: 'bot-lab' };
const A_ROOT = '1789000000.000100';
const B_ROOT = '1789500000.000100';
const chan = (c: { id: string; name: string }) => ({ id: c.id, name: c.name, is_channel: true, is_private: false, is_im: false, is_mpim: false, is_group: false });
const link = (c: { id: string }, ts: string, root?: string) =>
  `https://fake.slack.com/archives/${c.id}/p${ts.replace('.', '')}${root && root !== ts ? `?thread_ts=${root}&cid=${c.id}` : ''}`;
const msg = (user: string, ts: string, text: string, root: string) => ({ type: 'message', user, ts, text, thread_ts: root });

const THREAD_A = [
  { ...msg('U0RDPIP', A_ROOT, "did the friday tide report bot die? haven't seen a post in weeks", A_ROOT), reply_count: 4 },
  msg('U0RDREN', '1789000060.000100', 'nope, it got folded into Project Kestrel when the old cron box was retired. same bot, new codename', A_ROOT),
  msg('U0RDPIP', '1789000120.000100', "ahh ok. who maintains it now and what's it built with?", A_ROOT),
  msg('U0RDREN', '1789000180.000100', 'not sure tbh, the kestrel people have their own thread somewhere', A_ROOT),
  msg('U0RDTOV', '1789000240.000100', 'the tide report is alive btw, it was just renamed, see above', A_ROOT),
];
const THREAD_B = [
  { ...msg('U0RDMIRA', B_ROOT, 'Kestrel status thread: the weekly digests (tide report, ship recap) post from here now. questions below', B_ROOT), reply_count: 3 },
  msg('U0RDPIP', '1789500060.000100', "who maintains kestrel these days? and what's it written in?", B_ROOT),
  msg('U0RDMIRA', '1789500120.000100', "that's me (Mira), since the cron box move. it's written in Gleam and runs on one tiny VM", B_ROOT),
  msg('U0RDREN', '1789500180.000100', 'gleam, nice', B_ROOT),
];
const match = (c: { id: string; name: string }, m: any, root?: string) => ({ iid: m.ts, team: 'T0FAKE', channel: chan(c), type: 'message', user: m.user, ts: m.ts, text: m.text, permalink: link(c, m.ts, root) });

describe.skipIf(!LIVE)('research depth (LIVE)', () => {
  let sql: typeof import('../db/index.js').sql;
  let redis: typeof import('../core/redis.js').redis;
  let fakeCalls: typeof import('../core/slack-fake.js').fakeCalls;
  const removers: (() => void)[] = [];
  const queries: string[] = [];
  const opened = new Set<string>();
  const user = `U0RD${Date.now().toString(36).toUpperCase()}`;

  async function freshThread(tag: string) {
    const ts = `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const id = `C_${tag}:${ts}`;
    await sql`insert into threads (id, channel_id, thread_ts, engaged) values (${id}, ${`C_${tag}`}, ${ts}, true)`;
    return { id, ts };
  }

  beforeAll(async () => {
    ({ sql } = await import('../db/index.js'));
    ({ redis } = await import('../core/redis.js'));
    const fake = await import('../core/slack-fake.js');
    fakeCalls = fake.fakeCalls;
    await import('./register.js');
    await import('../tools/index.js');
    await import('../features/register.js');
    removers.push(
      fake.addFakeHandler((method, args) => {
        if (method === 'search.messages') {
          const q = String(args.query);
          queries.push(q);
          if (/kestrel/i.test(q)) return { ok: true, query: q, messages: { total: 2, matches: [match(BOTLAB, THREAD_B[0]), match(BOTLAB, THREAD_B[1], B_ROOT)] } };
          if (/tide|report|digest|bot|weekly|friday/i.test(q))
            return {
              ok: true,
              query: q,
              messages: {
                total: 2,
                matches: [match(LOUNGE, THREAD_A[4], A_ROOT), match(LOUNGE, { user: 'U0RDTOV', ts: '1788990000.000100', text: 'tide pool photos from the beach trip are up in the drive' })],
              },
            };
          return { ok: true, query: q, messages: { total: 0, matches: [] } };
        }
        const c = [LOUNGE, BOTLAB].find((x) => x.id === args.channel);
        if (!c) return undefined;
        if (method === 'conversations.info') return { ok: true, channel: { ...chan(c), is_member: false } };
        if (method === 'conversations.replies') {
          const thread = c === LOUNGE ? THREAD_A : THREAD_B;
          const root = c === LOUNGE ? A_ROOT : B_ROOT;
          if (args.ts === root) {
            opened.add(c.name);
            return { ok: true, messages: thread, has_more: false };
          }
          const one = thread.find((m) => m.ts === args.ts);
          return { ok: true, messages: one ? [one] : [], has_more: false };
        }
        if (method === 'conversations.history') return { ok: true, messages: [c === LOUNGE ? THREAD_A[0] : THREAD_B[0]], has_more: false };
        return undefined;
      }),
    );
  });

  afterAll(async () => {
    if (!LIVE) return;
    for (const r of removers) r();
    const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
    await queue(QUEUE.subagentRun).obliterate({ force: true }).catch(() => {});
    await queue(QUEUE.cardRender).obliterate({ force: true }).catch(() => {});
    await closeQueues();
    await redis.quit();
    await sql.end();
  });

  it('a subagent follows a codename from one thread to another thread that holds the answer', async () => {
    const { spawnSubagent } = await import('./subagents.js');
    const { processSubagentRun } = await import('./child.js');
    const th = await freshThread('RDHOP');
    const owner = `${user}H`;
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, status) values (${th.id}, ${owner}, 'running') returning id`;
    queries.length = 0;
    opened.clear();
    const s = await spawnSubagent({
      threadId: th.id,
      turnId: Number(t.id),
      ownerId: owner,
      title: 'Tide report bot',
      instructions:
        'In this Slack workspace, find out who currently maintains the bot that posts the weekly "tide report", and what language it is written in. Cite Slack permalinks.',
    });
    const started = Date.now();
    await processSubagentRun(s.runId);
    const [run] = await sql<any[]>`select status, result, tokens from runs where id = ${s.runId}`;
    const steps = await sql<any[]>`select payload from thread_events where thread_id = ${th.id} and type = 'run_step' order by id`;
    const tools = steps.flatMap((e) => e.payload.tools ?? []);
    // eslint-disable-next-line no-console
    console.log('multi-hop run:', run.status, `${Math.round((Date.now() - started) / 1000)}s`, run.tokens, 'tokens |', steps.length, 'steps |', JSON.stringify(tools), '| queries:', JSON.stringify(queries), '| opened:', [...opened], '|', String(run.result).slice(0, 600));
    expect(run.status).toBe('complete');
    expect(opened.has('lounge')).toBe(true); // opened thread A (where the codename is)
    expect(queries.some((q) => /kestrel/i.test(q))).toBe(true); // searched the lead
    expect(opened.has('bot-lab')).toBe(true); // opened thread B (where the answer is)
    expect(run.result).toMatch(/gleam/i);
    expect(run.result).toMatch(/mira|U0RDMIRA/i);
    // Slack search is shared and rate-limited: read leads instead of spraying keyword variants.
    expect(queries.length).toBeLessThanOrEqual(8);
  }, 420_000);

  /**
   * A lore quiz whose three results came back strong / partial / thin, then the synthesis turn. `deadline`: the speaker
   * set one that leaves no time for more research. `lead`: the partial result names a lead it didn't get to.
   */
  async function partialResultsSynthesis(tag: string, opts: { deadline: boolean; lead: boolean }) {
    const { runFrontTurn } = await import('./front.js');
    const { ensureTurnCard } = await import('./cards.js');
    const th = await freshThread(tag);
    const owner = `${user}${tag.slice(-1)}`;
    const deadline = new Date(Date.now() + 90_000).toISOString().slice(11, 16);
    threadText.set(th.id, {
      history: `<@${owner}> Tester: @Smasnug workspace lore quiz${opts.deadline ? `, deadline ${deadline} UTC` : ', no rush'}. three parts, at least 120 words each, and put a source next to every fact:
1) what is the "midnight muffin" tradition in #lounge?
2) who started #pixel-garden, and why?
3) what does the :ferris-wheel: reaction mean around here?
[bot] Smasnug: on it, checking all three at once`,
      newMessages: '',
    });
    const [t] = await sql<any[]>`insert into turns (thread_id, author_id, status, is_mention) values (${th.id}, ${owner}, 'done', true) returning id`;
    const cardId = await ensureTurnCard({ threadId: th.id, turnId: Number(t.id) });
    const L = (c: string, ts: string) => `https://fake.slack.com/archives/${c}/p${ts.replace('.', '')}`;
    const why = opts.lead
      ? `- Why: not found yet. Searched "pixel-garden" (oldest first) and "plant a pixel". Lead not followed (ran out of budget): Ozzie's launch post links the repo https://github.com/ozzie-rd/pixel-garden ("readme has the backstory"), not opened yet; Ozzie's own messages (from:@Ozzie) not searched either.`
      : `- Why: not found. Searched "pixel-garden" (oldest first), "plant a pixel", "why pixel garden", from:@Ozzie, and the first 3 threads in the channel; none says why it was started.`;
    const results: [string, string, string][] = [
      [
        'Midnight muffin',
        'Q1: the "midnight muffin" tradition in #lounge',
        `Confirmed by several messages:
- Every first Friday of the month at midnight UTC, people post a photo of a muffin (or any baked thing) in #lounge and the most chaotic one gets the :muffin-crown: emoji. "first friday muffin drop, midnight utc as usual, best one gets the crown" — <@U0RDJUN> in <#C0RDLOUNGE|lounge> ${L('C0RDLOUNGE', '1785000000.000100')}
- It started in 2024 when someone baked blueberry muffins during a late-night hackathon call: "this all started with my sad blueberry muffins during the 2am jam call lol" — <@U0RDJUN> ${L('C0RDLOUNGE', '1760000000.000100')}
- A 2025 thread counts 40+ muffin photos in one night ${L('C0RDLOUNGE', '1790000000.000100')}.
SUMMARY: Monthly midnight muffin photo drop in #lounge, started 2024`,
      ],
      [
        'Pixel garden founder',
        'Q2: who started #pixel-garden and why',
        `Partial.
- Founder: likely <@U0RDOZZ> (Ozzie). The earliest message in <#C0RDPIXEL|pixel-garden> is theirs: "welcome to the garden! plant a pixel, one per day" ${L('C0RDPIXEL', '1770000000.000100')}. Channel info wasn't available to confirm the creator.
${why}
- What it is today: people add one pixel a day to a shared 64x64 canvas; a bot posts the image weekly ${L('C0RDPIXEL', '1788000000.000100')}.
SUMMARY: Ozzie likely started #pixel-garden; the reason isn't known yet`,
      ],
      [
        'Ferris wheel emoji',
        'Q3: what the :ferris-wheel: reaction means',
        `Thin evidence.
- One message: "slapping :ferris-wheel: on it = it went round the full review loop and is shipped" — <@U0RDTOV> in <#C0RDSHIP|ship> ${L('C0RDSHIP', '1786000000.000100')} (one person's description).
- It appears as a reaction on 5 #ship posts that announce finished projects (e.g. ${L('C0RDSHIP', '1786100000.000100')}), which fits "shipped".
- Couldn't find who made the emoji or when.
SUMMARY: :ferris-wheel: probably means a project went through review and shipped`,
      ],
    ];
    for (const [title, instructions, result] of results) {
      const saId = `sa_rd${Math.random().toString(36).slice(2, 8)}`;
      await sql`insert into subagents (id, thread_id, owner_id, title, status, summary) values (${saId}, ${th.id}, ${owner}, ${title}, 'idle', ${result.split('SUMMARY: ')[1]!})`;
      await sql`insert into runs (subagent_id, thread_id, card_id, turn_id, instructions, status, output, result, started_at, finished_at)
        values (${saId}, ${th.id}, ${cardId}, ${t.id}, ${instructions}, 'complete', ${result.split('SUMMARY: ')[1]!}, ${result.split('\nSUMMARY: ')[0]!}, now(), now())`;
    }
    const [synth] = await sql<any[]>`
      insert into turns (thread_id, author_id, kind, card_id, status) values (${th.id}, ${owner}, 'synthesis', ${cardId}, 'running') returning *`;
    const before = (await fakeCalls()).length;
    await runFrontTurn({ ...synth, id: Number(synth.id), cardId, messageTs: [] }, { drainInbox: async () => [], setPhase: async () => {}, isMention: false });
    const calls = (await fakeCalls()).slice(before);
    // What the reply tool delivered (however it went out: stream, adopted activity message, post).
    const replies = await sql<{ text: string | null }[]>`
      select payload->>'text' as text from thread_events where thread_id = ${th.id} and type = 'reply' order by id`;
    const replyText = replies.map((r) => r.text ?? '').join('\n');
    const canvas = calls.filter((c) => c.method === 'canvases.create').map((c) => c.args.document_content?.markdown ?? '').join('\n');
    const text = `${replyText}\n${canvas}`;
    const words = text.split(/\s+/).filter(Boolean).length;
    const newRuns = await sql<{ instructions: string }[]>`select instructions from runs where thread_id = ${th.id} and card_id is distinct from ${cardId}`;
    // eslint-disable-next-line no-console
    console.log(`${tag} (${words} words, canvas: ${canvas.length > 0}, new runs: ${newRuns.length}):\n${text}\n${newRuns.map((r) => `NEW RUN: ${r.instructions}`).join('\n')}`);
    return { text, words, newRuns };
  }

  it('a synthesis with partial results answers every part with caveats, at the requested length', async () => {
    const { text, words, newRuns } = await partialResultsSynthesis('RDSYN', { deadline: true, lead: false });
    expect(newRuns).toHaveLength(0); // deadline: no new round
    expect(text).not.toMatch(/(can['’]?t|cannot|unable to) (responsibly |honestly )?(fill|complete|answer|write)|not enough (verified )?(lore|info|information|evidence) to/i);
    expect(text).toMatch(/muffin/i);
    expect(text).toMatch(/ozzie|U0RDOZZ/i);
    expect(text).toMatch(/ship/i);
    expect(text).toMatch(/(not found|couldn['’]?t (find|confirm)|no source|unclear|unknown|didn['’]?t find|not (documented|recorded|stated|mentioned)|isn['’]?t (recorded|documented))/i);
    expect(words).toBeGreaterThanOrEqual(300);
  }, 180_000);

  it('with time left and an unfollowed lead, the synthesis starts a focused next round on that gap', async () => {
    const { newRuns } = await partialResultsSynthesis('RDGAP', { deadline: false, lead: true });
    expect(newRuns.length).toBeGreaterThanOrEqual(1);
    expect(newRuns.length).toBeLessThanOrEqual(2); // just the gap(s), not the whole quiz again
    expect(newRuns.map((r) => r.instructions).join('\n')).toMatch(/pixel|ozzie/i);
  }, 180_000);
});
