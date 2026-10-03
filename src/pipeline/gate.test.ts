import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.GATE_MODEL = 'typesafe/jev-1.13';
  process.env.GATE_THRESHOLD = '0.8';
});
const generateText = vi.fn();
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText: (...a: unknown[]) => generateText(...a) }));

const { runGate, decisionsRequest } = await import('./gate.js');

const msg = (text: string, userId = 'U1') => ({ channelId: 'C1', ts: '1.1', threadId: 'C1:1.0', userId, botId: null, username: null, text, files: [], editedAt: null, deleted: false });
const opts = { context: [msg('<@UBOT> what board?'), { ...msg('pico 2 w'), userId: 'UBOT', botId: 'B1' }], newMessages: [msg('does it do bluetooth?')], botUserId: 'UBOT' };

afterEach(() => {
  vi.unstubAllGlobals();
  generateText.mockReset();
});

describe('relevance gate', () => {
  it('asks the decisions model one typed yes/no question', () => {
    const body = decisionsRequest({ model: 'typesafe/jev-1.13', context: 'a', newMessages: 'b', botName: 'bot' });
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state).toMatchObject({ recent_messages: 'a', newest_messages: 'b' });
    expect(body.questions.should_respond.type).toBe('noul');
  });

  it('responds when the probability reaches the threshold', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13-x', answers: { should_respond: { type: 'noul', noul: 0.9 } }, usage: { cost: 0.00002, input_tokens: 400 } })));
    vi.stubGlobal('fetch', fetchMock);
    const r = await runGate(opts);
    expect(r).toMatchObject({ respond: true, probability: 0.9, model: 'typesafe/jev-1.13-x' });
    expect(String((fetchMock.mock.calls[0] as any)[0])).toContain('/api/alpha/decisions');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('stays quiet below the threshold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: { should_respond: { noul: 0.75 } } }))));
    expect(await runGate(opts)).toMatchObject({ respond: false, probability: 0.75 });
  });

  it('falls back to the chat model when the decisions API fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"down"}}', { status: 503 })));
    generateText.mockResolvedValueOnce({ text: 'yes', usage: { inputTokens: 80, outputTokens: 1 } });
    const r = await runGate(opts);
    expect(r.respond).toBe(true);
    expect(r.fallback).toMatch(/503/);
    expect(r.model).toBe(process.env.MODEL_LUNA ?? 'openai/gpt-6-luna');
  });
});
