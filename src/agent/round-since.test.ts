import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { renderSinceRound, type SinceItem } from './round-since.js';

const msg = (ts: string, userId: string, self = false): SinceItem => ({ kind: 'message', at: Number(ts) * 1000, ts, userId, self });

describe('renderSinceRound', () => {
  it('is empty when nothing happened since the round started', () => {
    expect(renderSinceRound([])).toBe('');
  });

  it('lists later messages by author and ts, and the agent actions in between, oldest first', () => {
    const items: SinceItem[] = [
      { kind: 'cancel', at: 1790000002_500, subagentId: 'sa_aa11', title: 'Research topic A', actor: 'U1', turnTs: ['1790000002.000100'] },
      msg('1790000003.000100', 'UBOT', true),
      msg('1790000002.000100', 'U1'),
      { kind: 'spawn', at: 1790000004_000, subagentId: 'sa_bb22', title: 'Check topic B', actor: 'U2', turnTs: [] },
    ];
    expect(renderSinceRound(items)).toBe(
      [
        'Since this round started (oldest first; the messages are in <thread_history>):',
        '- <@U1> wrote [1790000002.000100]',
        '- you cancelled sa_aa11 "Research topic A" (in your turn for [1790000002.000100])',
        '- you replied [1790000003.000100]',
        '- you started sa_bb22 "Check topic B"',
      ].join('\n'),
    );
  });

  it('names Stop presses and a deleted thread root', () => {
    const out = renderSinceRound([
      { kind: 'stop_all', at: 1, actor: 'U3', thisCard: true },
      { kind: 'stop_all', at: 2, actor: 'U3', thisCard: false },
      { kind: 'stop_all', at: 3, actor: 'system', thisCard: true },
      { kind: 'steer', at: 4, subagentId: 'sa_cc33', title: null, actor: 'U1', turnTs: ['1790000005.000100', '1790000004.000100'] },
      { kind: 'resume', at: 5, subagentId: 'sa_dd44', title: 'x'.repeat(200), actor: 'U1', turnTs: [] },
    ]);
    const lines = out.split('\n').slice(1);
    expect(lines[0]).toBe('- <@U3> pressed Stop on this card');
    expect(lines[1]).toBe('- <@U3> pressed Stop on a plan card');
    expect(lines[2]).toMatch(/first message was deleted/);
    expect(lines[3]).toBe('- you messaged sa_cc33 (in your turn for [1790000004.000100] [1790000005.000100])');
    expect(lines[4]!.length).toBeLessThan(120);
  });

  it('keeps the newest items and says how many earlier ones it left out', () => {
    const items = Array.from({ length: 25 }, (_, i) => msg(`17900000${String(10 + i)}.000100`, 'U1'));
    const lines = renderSinceRound(items, 20).split('\n');
    expect(lines).toHaveLength(22);
    expect(lines[1]).toBe('- … 5 earlier');
    expect(lines[2]).toBe('- <@U1> wrote [1790000015.000100]');
    expect(lines.at(-1)).toBe('- <@U1> wrote [1790000034.000100]');
  });
});
