import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { addSource, urlsInText, chooseDelivery, clipTokens, compactHistory, describeToolStep, isNearDuplicate, splitResult, type RunSource } from './util.js';

describe('chooseDelivery', () => {
  it('streams when nothing runs, posts whole while runs are active, streams synthesis', () => {
    expect(chooseDelivery({ turnKind: 'user', runningRuns: 0 })).toBe('stream');
    expect(chooseDelivery({ turnKind: 'user', runningRuns: 2 })).toBe('post');
    expect(chooseDelivery({ turnKind: 'synthesis', runningRuns: 0 })).toBe('stream');
    expect(chooseDelivery({ turnKind: 'synthesis', runningRuns: 1 })).toBe('stream');
  });
});

describe('splitResult', () => {
  it('extracts the SUMMARY line', () => {
    expect(splitResult('Found things.\n- a\n- b\n\nSUMMARY: Found 2 things')).toEqual({ result: 'Found things.\n- a\n- b', output: 'Found 2 things' });
    expect(splitResult('Body\n**SUMMARY:** bold summary').output).toBe('bold summary');
  });
  it('falls back to the first sentence', () => {
    expect(splitResult('Bun is faster. Node is more compatible.').output).toBe('Bun is faster.');
    expect(splitResult('').output).toBe('Finished (no result)');
    expect(splitResult('- **Rust:** Fast. Safe.\n- Go').output).toBe('Rust: Fast.');
    expect(splitResult('## Findings\nmore').output).toBe('Findings');
  });
});

describe('clipTokens', () => {
  it('leaves short text alone and clips long text', () => {
    expect(clipTokens('short', 10)).toBe('short');
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const head = clipTokens(long, 50, 'head');
    expect(head.startsWith('line 0')).toBe(true);
    expect(head).toContain('[… section truncated]');
    const tail = clipTokens(long, 50, 'tail', 'older truncated');
    expect(tail.endsWith('line 199')).toBe(true);
    expect(tail.startsWith('[… older truncated]')).toBe(true);
    expect(tail.length).toBeLessThan(260);
  });
});

describe('compactHistory', () => {
  it('cuts tool results, drops reasoning and images', () => {
    const big = 'x'.repeat(5000);
    const msgs: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'task' }, { type: 'image', image: 'aGVsbG8=', mediaType: 'image/png' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'fetch_url', input: { url: 'https://a' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'fetch_url', output: { type: 'text', value: big } }] },
      { role: 'assistant', content: 'final answer' },
    ];
    const out = compactHistory(msgs);
    expect((out[0] as any).content[1]).toEqual({ type: 'text', text: '[image omitted]' });
    expect((out[1] as any).content).toHaveLength(1);
    const tr = (out[2] as any).content[0];
    expect(tr.output.type).toBe('text');
    expect(tr.output.value.length).toBeLessThan(500);
    expect(tr.output.value).toContain('[compacted]');
    expect(out[3]).toEqual(msgs[3]);
  });
});

describe('describeToolStep', () => {
  it('produces readable progress lines', () => {
    expect(describeToolStep('fetch_url', { url: 'https://example.com' })).toBe('Reading https://example.com');
    expect(describeToolStep('slack_search', { query: 'hackathon' })).toBe('Searching Slack for “hackathon”');
    expect(describeToolStep('mystery', {})).toBe('Using mystery');
  });
});

describe('isNearDuplicate', () => {
  it('flags repeated replies', () => {
    expect(isNearDuplicate('On it!', 'on it')).toBe(true);
    expect(isNearDuplicate("I'm checking the Raspberry Pi specs now.", "**I'm checking the Raspberry Pi specs now** — hang on")).toBe(true);
    expect(isNearDuplicate('The Pico 2 is the latest model. It has an RP2350.', 'The Pico 2 is the latest model! Here is a table: ...')).toBe(true);
    expect(isNearDuplicate('Checking the official Raspberry Pi product pages and specs now', 'checking official Raspberry Pi product pages and the specs')).toBe(true);
  });
  it('keeps different replies', () => {
    expect(isNearDuplicate('On it — digging through the docs.', 'The Pico 2 has an RP2350 with 520 KB SRAM and costs $5.')).toBe(false);
    expect(isNearDuplicate('ok', 'sure')).toBe(false);
    expect(isNearDuplicate('', 'anything')).toBe(false);
  });
});

describe('addSource', () => {
  it('keeps http(s) URLs once (ignoring fragment / trailing slash), with titles, capped', () => {
    const list: RunSource[] = [];
    expect(addSource(list, 'https://www.raspberrypi.com/products/pico-2/', 'Pico 2')).toBe(true);
    expect(addSource(list, 'https://www.raspberrypi.com/products/pico-2#specs')).toBe(false);
    expect(addSource(list, 'javascript:alert(1)')).toBe(false);
    expect(addSource(list, 'not a url')).toBe(false);
    expect(addSource(list, 42)).toBe(false);
    expect(list).toEqual([{ url: 'https://www.raspberrypi.com/products/pico-2/', title: 'Pico 2' }]);
    for (let i = 0; i < 20; i++) addSource(list, `https://example.com/${i}`);
    expect(list).toHaveLength(10);
    const l2: RunSource[] = [];
    addSource(l2, 'https://nodejs.org/en/download/current?trk=article&utm_source=openai&v=1');
    expect(l2[0]!.url).toBe('https://nodejs.org/en/download/current?v=1');
    addSource(l2, 'https://nodejs.org/en/download.?utm_source=openai');
    expect(l2[1]!.url).toBe('https://nodejs.org/en/download');
  });

  it('finds URLs in result text', () => {
    expect(urlsInText('See [docs](https://a.com/x). Also https://b.org/y, and **https://c.net/z**.')).toEqual(['https://a.com/x', 'https://b.org/y', 'https://c.net/z']);
  });
});
