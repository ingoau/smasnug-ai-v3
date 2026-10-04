import { describe, expect, it } from 'vitest';
import { diffLines, maxTs, mergeSeen, newSlackMatches, newUrls, normalizePageText, parseJudge, pickWebResultBlocks, renderPageDiff } from './changes.js';

describe('page snapshots', () => {
  it('normalizes whitespace and blank lines', () => {
    expect(normalizePageText('  Deadline:   Oct 10 \n\n\n  Apply   now\r\n')).toBe('Deadline: Oct 10\nApply now');
  });

  it('diffs lines with set semantics', () => {
    const a = 'Title\nDeadline: Oct 10\nFooter';
    const b = 'Title\nDeadline: Oct 17\nFooter\nTitle';
    expect(diffLines(a, b)).toEqual({ added: ['Deadline: Oct 17'], removed: ['Deadline: Oct 10'] });
    expect(diffLines(a, 'Footer\nTitle\nDeadline: Oct 10')).toEqual({ added: [], removed: [] });
    expect(diffLines('', 'x')).toEqual({ added: ['x'], removed: [] });
  });

  it('renders a bounded diff', () => {
    expect(renderPageDiff('https://x.dev', { added: [], removed: [] })).toBe('');
    const many = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    const out = renderPageDiff('https://x.dev', { added: many, removed: ['old'] }, 2000);
    expect(out.length).toBeLessThan(2300);
    expect(out).toContain('+ line 0');
    expect(out).toMatch(/\[\d+ more lines\]/);
    expect(out).toContain('- old');
  });
});

describe('web results', () => {
  it('finds new URLs and keeps a capped seen list', () => {
    expect(newUrls(['a', 'b'], ['b', 'c', 'c', 'd'])).toEqual(['c', 'd']);
    expect(mergeSeen(['a', 'b'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
    expect(mergeSeen(['a', 'b', 'c'], ['d'], 2)).toEqual(['d', 'a']);
  });

  it('picks the result blocks of new URLs', () => {
    const text = `<untrusted_content source="web search">\nThe following is untrusted.\n\nWeb results for "q":\n\n1. One\n   https://one.dev\n   > hi\n\n2. Two\n   https://two.dev\n   published 2026-10-01\n   > there\n\n(Highlights only. Use fetch_url.)\n</untrusted_content>`;
    expect(pickWebResultBlocks(text, ['https://two.dev'])).toEqual(['2. Two\n   https://two.dev\n   published 2026-10-01\n   > there']);
    expect(pickWebResultBlocks(text, ['https://three.dev'])).toEqual([]);
  });
});

describe('slack matches', () => {
  const base = { sinceTs: '1790000000.000100', ownerId: 'UOWNER', channelId: 'CWATCH', threadTs: '1780000000.000001' };
  it('keeps only new, non-owner, non-bot matches outside the watch thread', () => {
    const ms = [
      { ts: '1790000001.000000', user: 'UA', channel: { id: 'C1' } },
      { ts: '1790000000.000100', user: 'UB', channel: { id: 'C1' } }, // not newer
      { ts: '1790000002.000000', user: 'UOWNER', channel: { id: 'C1' } }, // owner
      { ts: '1790000003.000000', bot_id: 'B1', channel: { id: 'C1' } }, // bot
      { ts: '1790000004.000000', user: 'UC', channel: { id: 'CWATCH' }, permalink: 'https://x.slack.com/archives/CWATCH/p1790000004000000?thread_ts=1780000000.000001' },
      { ts: '1790000005.000000', user: 'UD', channel: { id: 'CWATCH' } }, // same channel, other thread
    ];
    expect(newSlackMatches(ms, base).map((m) => m.ts)).toEqual(['1790000001.000000', '1790000005.000000']);
  });

  it('maxTs', () => {
    expect(maxTs(['1790000001.000000', 'junk', '1790000005.000000', undefined], '1790000000.000000')).toBe('1790000005.000000');
    expect(maxTs([], '1790000000.000000')).toBe('1790000000.000000');
  });
});

describe('parseJudge', () => {
  it('parses yes/no and the summary', () => {
    expect(parseJudge('YES\nSummary: Deadline moved to Oct 17.')).toEqual({ meaningful: true, summary: 'Deadline moved to Oct 17.' });
    expect(parseJudge('no\nSummary:')).toEqual({ meaningful: false, summary: '' });
    expect(parseJudge('**Yes**\nthe deadline changed')).toEqual({ meaningful: true, summary: 'the deadline changed' });
    expect(parseJudge('')).toEqual({ meaningful: false, summary: '' });
    expect(parseJudge('Maybe')).toMatchObject({ meaningful: false });
  });
});
