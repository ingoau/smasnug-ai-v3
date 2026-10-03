import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { chooseDelivery, clipTokens, compactHistory, describeToolStep, isNearDuplicate, splitResult } from './util.js';

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
