import { describe, expect, it } from 'vitest';
import { frozenTitle, liveTitle, renderCard, STOP_ALL_ACTION, type CardRun } from './card-render.js';

const run = (id: number, over: Partial<CardRun> = {}): CardRun => ({
  id,
  subagentTitle: `Task ${id}`,
  status: 'queued',
  isResume: false,
  details: null,
  steerNotes: [],
  output: null,
  error: null,
  ...over,
});

const textOf = (rt: any) => rt?.elements?.[0]?.elements?.[0]?.text;

describe('card titles', () => {
  it('live title counts active runs', () => {
    expect(liveTitle([run(1), run(2, { status: 'running' })])).toBe('Running 2 subagents');
    expect(liveTitle([run(1, { status: 'complete' }), run(2, { status: 'running' })])).toBe('Running 1 subagent');
    expect(liveTitle([run(1, { status: 'complete' }), run(2, { status: 'error' })])).toBe('Ran 2 subagents');
  });

  it('frozen title falls back when missing or too long', () => {
    expect(frozenTitle('Compared 3 hosting options', 3)).toBe('Compared 3 hosting options');
    expect(frozenTitle(null, 3)).toBe('Ran 3 subagents');
    expect(frozenTitle('   ', 1)).toBe('Ran 1 subagent');
    expect(frozenTitle('x'.repeat(41), 2)).toBe('Ran 2 subagents');
    expect(frozenTitle('x'.repeat(40), 2)).toBe('x'.repeat(40));
  });
});

describe('renderCard', () => {
  it('maps run states to task cards', () => {
    const runs = [
      run(1),
      run(2, { status: 'running', details: 'Searching the web for “bun vs node”', steerNotes: ['also checking #ship'] }),
      run(3, { status: 'complete', output: 'Found 3 options' }),
      run(4, { status: 'error', error: 'Timed out' }),
      run(5, { status: 'cancelled' }),
      run(6, { status: 'running', isResume: true }),
    ];
    const { blocks, text } = renderCard({ id: 9, title: null, frozen: false }, runs);
    const plan = blocks[0] as any;
    expect(plan.type).toBe('plan');
    expect(plan.title).toBe('Running 3 subagents');
    const [q, r, c, e, x, resumed] = plan.tasks;
    expect(q).toMatchObject({ type: 'task_card', task_id: 'run_1', status: 'pending', title: 'Task 1' });
    expect(textOf(q.details)).toBe('Queued');
    expect(r.status).toBe('in_progress');
    expect(textOf(r.details)).toBe('Searching the web for “bun vs node”\n↪ also checking #ship');
    expect(c.status).toBe('complete');
    expect(textOf(c.output)).toBe('Found 3 options');
    expect(e.status).toBe('error');
    expect(textOf(e.details)).toBe('Timed out');
    expect(x.status).toBe('error');
    expect(textOf(x.details)).toBe('Cancelled');
    expect(resumed.title).toBe('↻ Task 6');
    // Stop all while anything runs
    const actions = blocks[1] as any;
    expect(actions.type).toBe('actions');
    expect(actions.elements[0]).toMatchObject({ action_id: STOP_ALL_ACTION, value: '9' });
    expect(text).toContain('Running 3 subagents');
    expect(text.length).toBeGreaterThan(0);
  });

  it('removes the button when nothing is active and freezes with the final title', () => {
    const runs = [run(1, { status: 'complete', output: 'ok' }), run(2, { status: 'cancelled' })];
    const live = renderCard({ id: 1, title: null, frozen: false }, runs);
    expect(live.blocks).toHaveLength(1);
    expect((live.blocks[0] as any).title).toBe('Ran 2 subagents');
    const frozen = renderCard({ id: 1, title: 'Checked the docs', frozen: true }, runs);
    expect(frozen.blocks).toHaveLength(1);
    expect((frozen.blocks[0] as any).title).toBe('Checked the docs');
    expect(frozen.text.startsWith('Checked the docs')).toBe(true);
  });

  it('frozen card never shows the button and orders runs by id', () => {
    const r = renderCard({ id: 1, title: 'A title that is definitely far too long for a card', frozen: true }, [run(3, { status: 'running' }), run(2)]);
    expect(r.blocks).toHaveLength(1);
    expect((r.blocks[0] as any).title).toBe('Ran 2 subagents');
    expect((r.blocks[0] as any).tasks.map((t: any) => t.task_id)).toEqual(['run_2', 'run_3']);
  });
});
