import { describe, expect, it } from 'vitest';
import { escapeMrkdwn, firstLine, renderStatusBlocks, runKindLabel, STATUS_MAX_ACTIVE, type StatusInput, type StatusRun } from './status-view.js';

const t0 = new Date('2026-11-17T10:00:00Z');
const base: StatusInput = { kind: 'task', brief: 'Fix the login bug\nmore details', openedBy: 'U1', createdAt: t0, lastActivityAt: t0, warnedAt: null, active: [], finished: [] };
const run = (o: Partial<StatusRun> = {}): StatusRun => ({ title: 'Research X', kind: 'subagent', status: 'running', startedAt: t0, createdAt: t0, finishedAt: null, inThread: false, ...o });
const texts = (blocks: unknown[]) => JSON.stringify(blocks);
const sectionTexts = (blocks: any[]) => blocks.filter((b) => b.type === 'section').map((b) => b.text.text as string);

describe('status tab rendering', () => {
  it('task: brief first line, opener, nothing running', () => {
    const blocks = renderStatusBlocks(base) as any[];
    const s = texts(blocks);
    expect(s).toContain('*Task:* Fix the login bug');
    expect(s).not.toContain('more details');
    expect(s).toContain('Opened by <@U1>');
    expect(s).toContain('<!date^' + Math.floor(t0.getTime() / 1000) + '^{ago}');
    expect(s).toContain('Nothing running.');
    expect(s).not.toContain('Recently finished');
  });

  it('fork and adopted kinds', () => {
    expect(texts(renderStatusBlocks({ ...base, kind: 'fork', brief: null, originPermalink: 'https://x.slack.com/p1' }))).toContain('*Forked* from <https://x.slack.com/p1|this message>');
    expect(texts(renderStatusBlocks({ ...base, kind: 'fork', brief: null }))).toContain('*Forked* from a thread');
    expect(texts(renderStatusBlocks({ ...base, kind: 'adopted', brief: null }))).toContain('*Adopted*');
  });

  it('running and finished runs with states', () => {
    const blocks = renderStatusBlocks({
      ...base,
      active: [run(), run({ title: 'Build it', kind: 'sandbox', status: 'queued', startedAt: null }), run({ title: 'Stop me', cancelRequested: true, inThread: true })],
      finished: [run({ title: 'A', status: 'complete', finishedAt: t0 }), run({ title: 'B', status: 'error', finishedAt: t0 }), run({ title: 'C', status: 'cancelled', finishedAt: t0 })],
    }) as any[];
    const [about = '', running = '', finished = ''] = sectionTexts(blocks);
    expect(about).toContain('Task');
    expect(running).toContain('*Running* (3)');
    expect(running).toContain('*Research X* · subagent · running, started');
    expect(running).toContain('*Build it* · sandbox · queued');
    expect(running).toContain('cancelling');
    expect(running).toContain('in a thread');
    expect(finished).toContain('*A* · subagent · done');
    expect(finished).toContain('*B* · subagent · failed');
    expect(finished).toContain('*C* · subagent · cancelled');
  });

  it('caps lists, truncates and escapes titles, stays within Block Kit limits', () => {
    const long = 'x'.repeat(500);
    const blocks = renderStatusBlocks({
      ...base,
      brief: `<!channel> & ${long}`,
      active: Array.from({ length: 30 }, (_, k) => run({ title: `<b>${k}</b> ${long}` })),
      finished: Array.from({ length: 20 }, () => run({ status: 'complete', finishedAt: t0, title: long })),
    }) as any[];
    expect(blocks.length).toBeLessThanOrEqual(100);
    for (const t of sectionTexts(blocks)) expect(t.length).toBeLessThanOrEqual(3000);
    const [about = '', running = '', finished = ''] = sectionTexts(blocks);
    expect(about).toContain('&lt;!channel&gt; &amp;');
    expect(about.length).toBeLessThan(300);
    expect(running).toContain('*Running* (30)');
    expect(running).toContain('…and 20 more');
    expect(running).toContain('&lt;b&gt;0&lt;/b&gt;');
    expect(running.split('\n').filter((l) => l.includes('subagent'))).toHaveLength(STATUS_MAX_ACTIVE);
    expect(finished.split('\n').filter((l) => l.includes('done'))).toHaveLength(5);
    expect(running).not.toContain('x'.repeat(100));
  });

  it('notes: waiting on, confirmations, archive warning', () => {
    const s = texts(renderStatusBlocks({ ...base, waitingOn: 'U2', pendingConfirmations: 2, warnedAt: t0, archivesAt: new Date(t0.getTime() + 86_400_000) }));
    expect(s).toContain('Waiting for a reply from <@U2>');
    expect(s).toContain('2 messages waiting for confirmation');
    expect(s).toContain('unless someone writes here');
  });

  it('same state, same blocks (refreshes can skip unchanged tabs)', () => {
    const input = { ...base, active: [run()] };
    expect(texts(renderStatusBlocks(input))).toBe(texts(renderStatusBlocks(structuredClone(input))));
  });

  it('helpers', () => {
    expect(firstLine('\n  a   b \nc', 10)).toBe('a b');
    expect(firstLine('abcdefghijkl', 5)).toBe('abcd…');
    expect(escapeMrkdwn('<a&b>')).toBe('&lt;a&amp;b&gt;');
    expect(runKindLabel({ sandbox: true, kind: 'model' })).toBe('sandbox');
    expect(runKindLabel({ sandbox: false, kind: 'cursor' })).toBe('coding agent');
    expect(runKindLabel({})).toBe('subagent');
  });
});
