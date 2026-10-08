import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { addSource, urlsInText, chooseDelivery, clipTokens, compactHistory, describeToolStep, isNearDuplicate, oneLine, splitResult, type RunSource } from './util.js';
import { sliceUnits, truncateChars } from '../tools/util.js';

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
    expect(describeToolStep('slack_search', { query: 'hackathon' })).toBe('Searching Slack for “hackathon”');
  });

  it('never shows tool names, file ids or whole URLs (users see these, also as the plan title)', () => {
    expect(describeToolStep('fetch_url', { url: 'https://www.docs.fly.io/reference/regions/?x=1' })).toBe('Reading docs.fly.io');
    expect(describeToolStep('fetch_url', { url: 'not a url' })).toBe('Reading not a url');
    expect(describeToolStep('fetch_url', {})).toBe('Reading a page');
    expect(describeToolStep('read_file', { file_id: 'file_abc123defg' }, { fileName: 'budget.xlsx' })).toBe('Opening budget.xlsx');
    expect(describeToolStep('ask_file', { file_id: 'file_abc123defg', question: 'q' }, { fileName: 'notes.pdf' })).toBe('Reading notes.pdf');
    expect(describeToolStep('read_file', { file_id: 'file_abc123defg' })).toBe('Opening a file');
    expect(describeToolStep('ask_file', { file_id: 'file_abc123defg' }, { fileName: '  ' })).toBe('Reading a file');
    expect(describeToolStep('read_canvas', { canvas: 'F123' })).toBe('Reading a canvas');
    // No label of its own: the status-indicator label, else "Working…".
    expect(describeToolStep('set_reminder', { text: 'x' })).toBe('Setting a reminder');
    expect(describeToolStep('mystery', { secret: 'internal' })).toBe('Working…');
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

describe('cutting text never splits an emoji (a lone surrogate breaks Postgres json writes)', () => {
  const isWellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  it('sliceUnits drops a dangling high surrogate', () => {
    expect(sliceUnits('ab🎮cd', 3)).toBe('ab');
    expect(sliceUnits('ab🎮cd', 4)).toBe('ab🎮');
    expect(sliceUnits('abc', 10)).toBe('abc');
  });
  it('oneLine, truncateChars and compactHistory stay well-formed wherever they cut', () => {
    const text = 'Run a game jam 🎮🎮 in town 🎉 '.repeat(30);
    for (let n = 1; n < 40; n++) {
      expect(isWellFormed(oneLine(text, n))).toBe(true);
      expect(isWellFormed(truncateChars(text, n))).toBe(true);
    }
    for (let pad = 0; pad < 4; pad++) {
      const msgs: ModelMessage[] = [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName: 'web_search', output: { type: 'text', value: 'x'.repeat(pad) + text } }] }];
      const out = compactHistory(msgs) as any;
      expect(isWellFormed(out[0].content[0].output.value)).toBe(true);
    }
  });
});
