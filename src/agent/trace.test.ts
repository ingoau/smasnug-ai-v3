import { describe, expect, it } from 'vitest';
import { asText, clip, promptHash, safeStr, sanitize, TraceRecorder, traceInput } from './trace.js';

describe('TraceRecorder', () => {
  it('records steps with text, reasoning, calls, results, notes and usage', () => {
    let t = 0;
    const r = new TraceRecorder(() => (t += 10));
    r.note('lookup nudge');
    r.ingest({ type: 'start-step' });
    r.ingest({ type: 'reasoning-delta', text: 'think ' });
    r.ingest({ type: 'reasoning-delta', text: 'more' });
    r.ingest({ type: 'text-delta', text: 'hi' });
    r.ingest({ type: 'tool-call', toolCallId: 'a', toolName: 'web_search', input: { query: 'x' } });
    r.ingest({ type: 'tool-call', toolCallId: 'b', toolName: 'fetch_url', input: { url: 'https://e.com' } });
    r.ingest({ type: 'tool-result', toolCallId: 'a', toolName: 'web_search', output: { results: [1] } });
    r.ingest({ type: 'tool-error', toolCallId: 'b', toolName: 'fetch_url', error: new Error('404') });
    r.ingest({ type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 80 } }, response: { modelId: 'openai/gpt-6-luna' } });
    r.ingest({ type: 'start-step' });
    r.ingest({ type: 'tool-call', toolCallId: 'c', toolName: 'reply', input: { text: 'done' } });
    const steps = r.finish();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      notes: ['lookup nudge'],
      text: 'hi',
      reasoning: 'think more',
      finishReason: 'tool-calls',
      model: 'openai/gpt-6-luna',
      usage: { input: 100, output: 5, cached: 80 },
      calls: [
        { name: 'web_search', input: { query: 'x' }, output: '{"results":[1]}' },
        { name: 'fetch_url', error: '404' },
      ],
    });
    expect(steps[0]!.calls[0]!.ms).toBeGreaterThan(0);
    expect(steps[1]).toMatchObject({ finishReason: 'interrupted', calls: [{ name: 'reply' }] });
  });

  it('keeps notes that never reached a step', () => {
    const r = new TraceRecorder();
    r.note({ role: 'user', content: 'x' });
    expect(r.finish()).toEqual([{ notes: ['{"role":"user","content":"x"}'], calls: [] }]);
  });

  it('keeps the whole trace within its size budget', () => {
    const r = new TraceRecorder(Date.now, 10_000);
    for (let i = 0; i < 10; i++) {
      r.ingest({ type: 'start-step' });
      r.ingest({ type: 'tool-call', toolCallId: `c${i}`, toolName: 'fetch_url', input: { url: 'x' } });
      r.ingest({ type: 'tool-result', toolCallId: `c${i}`, toolName: 'fetch_url', output: 'y '.repeat(2500) });
      r.ingest({ type: 'finish-step', finishReason: 'tool-calls', usage: {} });
    }
    const steps = r.finish();
    expect(steps).toHaveLength(10);
    expect(JSON.stringify(steps).length).toBeLessThan(14_000);
    expect(steps.at(-1)!.calls[0]!.output).toBe('[dropped: trace size budget]');
  });

  it('never throws on odd parts', () => {
    const r = new TraceRecorder();
    r.ingest({ type: 'tool-result', toolCallId: 'nope' });
    r.ingest({ type: 'something-new' });
    expect(r.finish()).toEqual([]);
  });
});

describe('sanitize / clip', () => {
  it('drops binary data and clips long strings', () => {
    const b64 = 'A'.repeat(5000);
    expect(sanitize({ type: 'image', data: b64, mediaType: 'image/png' })).toEqual({ type: 'image', data: '[binary]', mediaType: 'image/png' });
    expect(sanitize(`see ${b64}`)).toBe('see [binary]');
    expect(sanitize(new Uint8Array(3))).toBe('[binary]');
    expect(clip('abcdef', 3)).toBe('abc… [3 more chars]');
    expect(asText({ a: 'x'.repeat(50) }, 20)).toMatch(/^\{"a":"x+… \[\d+ more chars\]$/);
  });

  it('makes strings safe for jsonb', () => {
    expect(safeStr('a\u0000b')).toBe('ab');
    expect(safeStr('a\ud83d')).toBe('a\ufffd');
    // A cut right after a high surrogate never leaves half a pair.
    expect(clip('ab😀cd', 3)).toBe('ab… [4 more chars]');
    expect(sanitize({ when: new Date(0), err: new Error('boom'), ['k\u0000']: 1 })).toEqual({ when: '1970-01-01T00:00:00.000Z', err: 'boom', k: 1 });
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitize(many) as object)).toHaveLength(101);
  });

  it('keeps the turn input within budget', () => {
    const input = traceInput([
      { role: 'user', content: 'x'.repeat(200_000) },
      { role: 'user', content: 'tail' },
    ]);
    expect(input[0]!.content.length).toBeLessThan(121_000);
    expect(input[1]!.content).toBe('tail');
  });

  it('hashes prompts stably', () => {
    expect(promptHash('a')).toBe(promptHash('a'));
    expect(promptHash('a')).not.toBe(promptHash('b'));
    expect(promptHash('a')).toHaveLength(16);
  });
});
