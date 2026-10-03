import { describe, expect, it } from 'vitest';
import { frozenTitle, liveTitle, outputBudget, renderCard, taskFor, type CardRun } from './card-render.js';
import { markdownToRich } from './rich-text.js';

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

  it('frozen title is the model title, falling back only when missing', () => {
    expect(frozenTitle('Compared 3 hosting options', 3)).toBe('Compared 3 hosting options');
    expect(frozenTitle(null, 3)).toBe('Ran 3 subagents');
    expect(frozenTitle('   ', 1)).toBe('Ran 1 subagent');
    expect(frozenTitle('x'.repeat(41), 2)).toBe('x'.repeat(41)); // the model's title as written, even if long
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
    expect(c.output.elements[0].elements[0].style).toEqual({ bold: true });
    expect(e.status).toBe('error');
    expect(textOf(e.output)).toBe('Timed out');
    expect(x.status).toBe('error');
    expect(textOf(x.output)).toBe('Cancelled');
    expect(resumed.title).toBe('↻ Task 6');
    // No buttons: just the plan
    expect(blocks.map((b) => b.type)).toEqual(['plan']);
    expect(text).toContain('Running 3 subagents');
    expect(text.length).toBeGreaterThan(0);
  });

  it('freezes with the final title when nothing is active', () => {
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
    const r = renderCard({ id: 1, title: null, frozen: true }, [run(3, { status: 'running' }), run(2)]);
    expect(r.blocks).toHaveLength(1);
    expect((r.blocks[0] as any).title).toBe('Ran 2 subagents');
    expect((r.blocks[0] as any).tasks.map((t: any) => t.task_id)).toEqual(['run_2', 'run_3']);
  });

  it('lives in the reply message: [reply markdown, plan], text = reply text; frozen keeps the text', () => {
    const runs = [run(1, { status: 'running', details: 'Reading docs' })];
    const live = renderCard({ id: 4, title: null, frozen: false, replyText: 'On it — checking the docs.' }, runs);
    expect(live.blocks.map((b) => b.type)).toEqual(['markdown', 'plan']);
    expect((live.blocks[0] as any).text).toBe('On it — checking the docs.');
    expect(live.text).toBe('On it — checking the docs.');
    const frozen = renderCard({ id: 4, title: 'Checked the docs', frozen: true, replyText: 'On it — checking the docs.' }, [run(1, { status: 'complete', output: 'ok' })]);
    expect(frozen.blocks.map((b) => b.type)).toEqual(['markdown', 'plan']);
    expect((frozen.blocks[1] as any).title).toBe('Checked the docs');
    expect(frozen.text).toBe('On it — checking the docs.');
    // Over Slack's 12k markdown budget: rendered as rich_text (nothing cut), fallback text 3k.
    const long = renderCard({ id: 4, title: null, frozen: false, replyText: 'x'.repeat(20_000) }, runs);
    expect(long.blocks.map((b) => b.type)).toEqual(['rich_text', 'plan']);
    expect(long.text.length).toBe(3_000);
  });

  it('a reply with code keeps it as rich_text preformatted above the plan, with stable block ids', () => {
    const replyText = 'Here:\n```html\n<h1>Hello, world!</h1>\n```\nMore soon.';
    const r = renderCard({ id: 5, title: null, frozen: false, replyText }, [run(1)]);
    expect(r.blocks.map((b) => b.type)).toEqual(['markdown', 'rich_text', 'markdown', 'plan']);
    expect(r.blocks.map((b) => (b as any).block_id)).toEqual(['card_5_reply', 'card_5_reply_1', 'card_5_reply_2', 'card_5_plan']);
    expect((r.blocks[1] as any).elements[0]).toEqual({ type: 'rich_text_preformatted', language: 'html', elements: [{ type: 'text', text: '<h1>Hello, world!</h1>' }] });
    expect(r.text).toBe(replyText);
  });
});

/** Visible text of a rich_text block (sections joined by newlines, list items prefixed). */
function plain(rt: any): string {
  const inl = (els: any[]) => els.map((e) => (e.type === 'link' ? (e.text ?? e.url) : e.text)).join('');
  return rt.elements
    .map((el: any) => (el.type === 'rich_text_list' ? el.elements.map((s: any) => `${el.style === 'bullet' ? '•' : '1.'} ${inl(s.elements)}`).join('\n') : inl(el.elements)))
    .join('\n');
}

describe('task card output', () => {
  const longResult = [
    '## Raspberry Pi Pico 2 W',
    'The **Pico 2 W** is the newest board (RP2350, see [the datasheet](https://datasheets.raspberrypi.com/pico/pico-2-w.pdf)).',
    '',
    '| Board | Chip | SRAM |',
    '|---|---|---|',
    '| Pico | RP2040 | 264 KB |',
    '| Pico 2 | RP2350 | 520 KB |',
    '',
    '- Dual Cortex-M33 or Hazard3 RISC-V cores',
    '- `PIO` blocks: 3 instead of 2',
    '- Security: Arm TrustZone, signed boot',
    ...Array.from({ length: 30 }, (_, i) => `More detail line ${i} that keeps going for a while to make this long.`),
  ].join('\n');

  it('shows the summary in bold, then a readable, truncated excerpt of the result', () => {
    const t = taskFor(run(1, { status: 'complete', output: 'Pico 2 W is the newest model', result: longResult }));
    const out = t.output as any;
    expect(out.elements[0].elements[0]).toEqual({ type: 'text', text: 'Pico 2 W is the newest model', style: { bold: true } });
    const text = plain(out);
    expect(text).toContain('Raspberry Pi Pico 2 W');
    expect(text).toContain('Pico · RP2040 · 264 KB');
    expect(text).toMatch(/…$/);
    expect(text.length).toBeLessThan(700 + 'Pico 2 W is the newest model'.length);
    // heading bold, link kept as a link, list as a rich_text_list
    expect(out.elements[1].elements[0].style).toEqual({ bold: true });
    expect(JSON.stringify(out)).toContain('"type":"link","url":"https://datasheets.raspberrypi.com/pico/pico-2-w.pdf","text":"the datasheet"');
  });

  it('keeps lists as rich_text_list and cuts by lines', () => {
    const els = markdownToRich('Intro\n- a\n- b\n1. one\n2. two\nOutro', { maxChars: 500, maxLines: 4 });
    expect(els.map((e) => e.type)).toEqual(['rich_text_section', 'rich_text_list', 'rich_text_list']);
    expect((els[1] as any).style).toBe('bullet');
    expect((els[2] as any).style).toBe('ordered');
    expect((els[2] as any).elements).toHaveLength(1);
    expect(JSON.stringify(els.at(-1))).toContain('…');
    expect(markdownToRich('short', { maxChars: 500, maxLines: 4 })).toEqual([{ type: 'rich_text_section', elements: [{ type: 'text', text: 'short' }] }]);
  });

  it('adds sources (deduped by the child, capped here) with readable labels', () => {
    const sources = [
      { url: 'https://www.raspberrypi.com/products/raspberry-pi-pico-2/', title: 'Buy a Raspberry Pi Pico 2' },
      { url: 'https://datasheets.raspberrypi.com/pico/pico-2-datasheet.pdf' },
      ...Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/${i}` })),
    ];
    const t = taskFor(run(1, { status: 'complete', output: 'ok', sources }));
    expect(t.sources).toHaveLength(5);
    expect(t.sources![0]).toEqual({ type: 'url', url: sources[0]!.url, text: 'Buy a Raspberry Pi Pico 2' });
    expect(t.sources![1]!.text).toBe('datasheets.raspberrypi.com/pico/pico-2-datasheet.pdf');
    // Running runs show their sources so far too; none → no field.
    expect(taskFor(run(2, { status: 'running', sources: sources.slice(0, 1) })).sources).toHaveLength(1);
    expect(taskFor(run(3, { status: 'running' })).sources).toBeUndefined();
  });

  it('shrinks excerpts and sources as runs pile up, and respects the 50-task plan limit', () => {
    expect(outputBudget(2)).toEqual({ maxChars: 600, maxLines: 8, sources: 5 });
    expect(outputBudget(5).maxChars).toBe(300);
    expect(outputBudget(10).maxChars).toBe(150);
    expect(outputBudget(20)).toEqual({ maxChars: 0, maxLines: 0, sources: 0 });
    const many = Array.from({ length: 60 }, (_, i) => run(i + 1, { status: 'complete', output: `Result ${i + 1}`, result: longResult, sources: [{ url: 'https://example.com/x' }] }));
    const { blocks } = renderCard({ id: 1, title: null, frozen: false }, many);
    const plan = blocks[0] as any;
    expect(plan.tasks).toHaveLength(50);
    expect(plan.tasks[0].task_id).toBe('run_11');
    // Summary only, no sources, with many runs.
    expect(plan.tasks[0].output.elements).toHaveLength(1);
    expect(plan.tasks[0].sources).toBeUndefined();
    expect(JSON.stringify(blocks).length).toBeLessThan(20_000);
    const four = renderCard({ id: 1, title: null, frozen: false }, many.slice(0, 4));
    const t0 = (four.blocks[0] as any).tasks[0];
    expect(plain(t0.output).length).toBeLessThan(300 + 40);
    expect(t0.sources).toHaveLength(1);
  });
});

describe('run durations in task titles', () => {
  it('formats compact durations', async () => {
    const { formatDuration } = await import('./card-render.js');
    expect(formatDuration(8_400)).toBe('8s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });
  it('shows elapsed while running, the total when finished, nothing when queued', async () => {
    const { taskFor } = await import('./card-render.js');
    const base = { id: 1, subagentTitle: 'Compare printers', isResume: false, details: 'Searching', steerNotes: [], output: 'ok', error: null };
    const started = new Date(Date.now() - 45_000);
    expect(taskFor({ ...base, status: 'running', startedAt: started }).title).toBe('Compare printers · 45s');
    expect(taskFor({ ...base, status: 'complete', startedAt: new Date(0), finishedAt: new Date(92_000) }).title).toBe('Compare printers · 1m 32s');
    expect(taskFor({ ...base, status: 'queued', startedAt: null }).title).toBe('Compare printers');
  });
});
