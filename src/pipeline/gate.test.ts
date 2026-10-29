import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.GATE_MODEL = 'typesafe/jev-1.13';
  process.env.GATE_THRESHOLD = '0.8';
});
const generateText = vi.fn();
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText: (...a: unknown[]) => generateText(...a) }));

const { runGate, decisionsRequest, describeGateError, gateDecisionReason } = await import('./gate.js');

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
    expect(r.fallbackKind).toBe('http');
    expect(r.model).toBe(process.env.MODEL_GATE ?? 'claude-haiku-5-5');
    expect(gateDecisionReason(r, 0.8)).toMatch(/^decisions model failed \(http\): decisions 503.*; .* answered "yes"$/);
  });

  it('a decisions timeout falls back with its cause; a failed fallback stays quiet and says why', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
    generateText.mockRejectedValueOnce(Object.assign(new Error(''), { name: 'APICallError' }));
    const r = await runGate(opts);
    expect(r).toMatchObject({ respond: false, fallback: 'timed out after 1500ms', fallbackKind: 'timeout', error: 'APICallError' });
    expect(gateDecisionReason(r, 0.8)).toBe('decisions model failed (timeout): timed out after 1500ms; gate failed, staying quiet: APICallError');
  });
});

describe('gate failure causes and decision reasons', () => {
  it('classifies failures with a never-empty message', () => {
    expect(describeGateError(new DOMException('x', 'TimeoutError'), 1500)).toEqual({ kind: 'timeout', message: 'timed out after 1500ms' });
    expect(describeGateError(new DOMException('', 'AbortError'))).toEqual({ kind: 'aborted', message: 'aborted' });
    expect(describeGateError(new Error('decisions 429: "slow down"'))).toEqual({ kind: 'http', message: 'decisions 429: "slow down"' });
    expect(describeGateError(new Error('decisions: no probability in response')).kind).toBe('invalid');
    const net = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } });
    expect(describeGateError(net)).toEqual({ kind: 'network', message: 'fetch failed: ECONNRESET socket hang up' });
    expect(describeGateError(new Error(''))).toEqual({ kind: 'error', message: 'Error' });
    expect(describeGateError('boom')).toEqual({ kind: 'error', message: 'boom' });
  });
  it('explains the decision: probability vs threshold, or the chat model answer', () => {
    expect(gateDecisionReason({ respond: false, raw: '0.560', probability: 0.56, latencyMs: 1, model: 'm' }, 0.65)).toBe('p=0.560 < threshold 0.65');
    expect(gateDecisionReason({ respond: true, raw: '0.7', probability: 0.7, latencyMs: 1, model: 'm' }, 0.65)).toBe('p=0.700 >= threshold 0.65');
    expect(gateDecisionReason({ respond: false, raw: ' no\n', latencyMs: 1, model: 'haiku' }, 0.8)).toBe('haiku answered "no"');
  });
});
