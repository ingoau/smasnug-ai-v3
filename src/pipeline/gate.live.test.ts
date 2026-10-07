/** LIVE=1 pnpm vitest run src/pipeline/gate.live.test.ts — calls OpenRouter (a few tiny requests). */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { StoredMessage } from '../core/types.js';

const LIVE = process.env.LIVE === '1';
if (LIVE && existsSync('.env')) process.loadEnvFile('.env');

const msg = (userId: string | null, text: string, bot = false): StoredMessage => ({
  channelId: 'C1',
  ts: String(Math.random()),
  threadId: 'C1:1.0',
  userId,
  botId: bot ? 'BBOT' : null,
  username: null,
  text,
  files: [],
  editedAt: null,
  deleted: false,
});

const thread = [
  msg('UALICE', '<@UBOT> what is the capital of Australia?'),
  msg('UBOT', 'The capital of Australia is Canberra.', true),
];

const cases: { name: string; context: StoredMessage[]; next: StoredMessage[]; expected: boolean }[] = [
  { name: 'follow-up question to the bot', context: thread, next: [msg('UALICE', 'and what about New Zealand?')], expected: true },
  { name: 'correction of the bot', context: thread, next: [msg('UBOB', "that's wrong, it's Sydney right?")], expected: true },
  { name: 'humans chatting', context: [...thread, msg('UBOB', 'are you coming to the hackathon tomorrow?')], next: [msg('UALICE', 'yeah i will be there at 10')], expected: false },
  { name: 'reaction', context: thread, next: [msg('UBOB', 'lol nice')], expected: false },
];

describe.skipIf(!LIVE)('gate (live)', () => {
  it.each(cases)('$name', async ({ context, next, expected }) => {
    const { runGate } = await import('./gate.js');
    const r = await runGate({ context, newMessages: next, botUserId: 'UBOT' });
    console.log(JSON.stringify({ raw: r.raw, latencyMs: r.latencyMs, in: r.inputTokens, out: r.outputTokens, error: r.error }));
    expect(r.error).toBeUndefined();
    expect(r.respond).toBe(expected);
  }, 30_000);
});

describe.skipIf(!LIVE)('gate (live): the bot\'s conversation partner', () => {
  const convo = [
    msg('UALICE', '<@UBOT> can you look at why my bot polls slack so often'),
    msg('UBOT', 'it polls conversations.history every 2s per channel; that is what burns your rate limit.', true),
  ];
  it.each([
    { name: 'short follow-up from the partner', next: 'decrease polling', expected: true },
    { name: 'unclear question from the partner', next: 'Whats nd studio?', expected: true },
  ])('$name', async ({ next, expected }) => {
    const { runGate } = await import('./gate.js');
    const { partnerGateNote } = await import('./fire.js');
    const r = await runGate({ context: convo, newMessages: [msg('UALICE', next)], botUserId: 'UBOT', threshold: 0.6, note: partnerGateNote('smasnug ai') });
    console.log(JSON.stringify({ next, raw: r.raw, probability: r.probability, fallback: r.fallback, error: r.error }));
    expect(r.error).toBeUndefined();
    expect(r.respond).toBe(expected);
  }, 30_000);
});

describe.skipIf(!LIVE)("gate (live): someone else answering the bot's offer", () => {
  const convo = [
    msg('UALICE', '<@UBOT> our club needs a signup sheet for the robotics workshop'),
    msg('UBOB', 'yeah we keep losing track of who is coming'),
    msg('UBOT', 'i can make a simple signup page with name, email and a t-shirt size field. want me to make it?', true),
  ];
  it.each([
    { name: 'a go-ahead from the other person', next: 'yes go for it', expected: true },
    { name: 'an aside to the other person', next: 'alice did you book the room yet', expected: false },
  ])('$name', async ({ next, expected }) => {
    const { runGate } = await import('./gate.js');
    const { answerGateNote } = await import('./fire.js');
    const r = await runGate({ context: convo, newMessages: [msg('UBOB', next)], botUserId: 'UBOT', threshold: 0.6, note: answerGateNote('smasnug ai') });
    console.log(JSON.stringify({ next, raw: r.raw, probability: r.probability, fallback: r.fallback, error: r.error }));
    expect(r.error).toBeUndefined();
    expect(r.respond).toBe(expected);
  }, 30_000);
});
