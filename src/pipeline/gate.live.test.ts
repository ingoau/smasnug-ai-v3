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
