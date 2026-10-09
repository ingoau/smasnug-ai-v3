import { describe, expect, it } from 'vitest';
import { frozenTitle, liveTitle, outputBudget, renderCard, taskFor, type CardRun } from './card-render.js';
import { cleanInlines, markdownToRich } from './rich-text.js';

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
  it('live title says what the work is, never "subagent"', () => {
    // Several tasks: how many, and how many are done once any are (a long round visibly moves).
    expect(liveTitle([run(1), run(2, { status: 'running' })])).toBe('Working on 2 tasks');
    expect(liveTitle([run(1, { status: 'complete' }), run(2, { status: 'running', details: 'Searching Slack for “x”' }), run(3)])).toBe('Working on 3 tasks · 1 done');
    expect(liveTitle([run(1, { status: 'complete' }), run(2, { status: 'error' }), run(3, { status: 'running' })])).toBe('Working on 3 tasks · 2 done');
    // One task: what it is doing right now, else its title (queued, or only thinking / writing up).
    expect(liveTitle([run(1, { status: 'running', details: 'Searching Slack for “demo day”' })])).toBe('Searching Slack for “demo day”');
    for (const details of [null, '  ', 'Researching…', 'Thinking…', 'Writing up…', 'Working…', 'Thinking… (30s)']) {
      expect(liveTitle([run(2, { status: 'running', details })])).toBe('Task 2');
    }
    expect(liveTitle([run(1, { status: 'running', details: 'Reading example.com (45s)' })])).toBe('Reading example.com (45s)');
    expect(liveTitle([run(1, { details: 'stale' })])).toBe('Task 1');
    expect(liveTitle([run(1, { status: 'running', subagentTitle: ' ' })])).toBe('Task');
    expect(liveTitle([run(1, { status: 'complete' }), run(2, { status: 'error' })])).toBe('Worked on 2 tasks');
  });

  it('frozen title is the model title, falling back only when missing', () => {
    expect(frozenTitle('Compared 3 hosting options', [run(1), run(2), run(3)])).toBe('Compared 3 hosting options');
    expect(frozenTitle(null, [run(1), run(2), run(3)])).toBe('Worked on 3 tasks');
    expect(frozenTitle('   ', [run(1, { subagentTitle: 'Check the venue' })])).toBe('Check the venue');
    expect(frozenTitle('x'.repeat(41), [run(1), run(2)])).toBe('x'.repeat(41)); // the model's title as written, even if long
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
    expect(plan.title).toBe('Working on 6 tasks · 3 done');
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
    expect(text).toContain('Working on 6 tasks · 3 done');
    expect(text.length).toBeGreaterThan(0);
  });

  it('a finished card stays a plan block: every task final, titled by its summary, then its background title', () => {
    const runs = [
      run(1, { status: 'complete', output: 'ok', sources: [{ url: 'https://example.com/a', title: 'Doc A' }] }),
      run(2, { status: 'cancelled' }),
    ];
    const done = renderCard({ id: 1, title: null, frozen: false }, runs);
    expect(done.blocks).toHaveLength(1);
    const plan = done.blocks[0] as any;
    expect(plan).toMatchObject({ type: 'plan', block_id: 'card_1_plan', title: 'Worked on 2 tasks' });
    // The subagent runs are still listed (Slack shows the plan collapsed to its title, expandable on click).
    expect(plan.tasks.map((t: any) => [t.task_id, t.title, t.status])).toEqual([
      ['run_1', 'Task 1', 'complete'],
      ['run_2', 'Task 2', 'error'],
    ]);
    expect(textOf(plan.tasks[0].output)).toBe('ok');
    expect(plan.tasks[0].sources).toEqual([{ type: 'url', url: 'https://example.com/a', text: 'Doc A' }]);
    expect(textOf(plan.tasks[1].output)).toBe('Cancelled');
    expect(done.text.split('\n')[0]).toBe('Worked on 2 tasks');
    const frozen = renderCard({ id: 1, title: 'Checked the docs', frozen: true }, runs);
    expect((frozen.blocks[0] as any).title).toBe('Checked the docs');
    expect((frozen.blocks[0] as any).tasks).toEqual(plan.tasks);
    expect(frozen.text.startsWith('Checked the docs')).toBe(true);
  });

  it('a frozen card finishes its steps; a run still marked active keeps its real status; the title never pings', () => {
    const r = renderCard({ id: 1, title: '<!channel> & co', frozen: true, steps: [{ tool: 'web_search', status: 'in_progress' }] }, [run(3, { status: 'running' }), run(2)]);
    expect(r.blocks).toHaveLength(1);
    const plan = r.blocks[0] as any;
    expect(plan.type).toBe('plan');
    expect(plan.title).not.toContain('<!channel>');
    expect(plan.title).toContain('& co');
    expect(plan.tasks.map((t: any) => [t.task_id, t.title, t.status])).toEqual([
      ['step_1', 'Searched the web', 'complete'],
      ['run_2', 'Task 2', 'pending'],
      ['run_3', 'Task 3', 'in_progress'],
    ]);
  });

  it('orders runs by id while live', () => {
    const r = renderCard({ id: 1, title: null, frozen: false }, [run(3, { status: 'running' }), run(2)]);
    expect((r.blocks[0] as any).tasks.map((t: any) => t.task_id)).toEqual(['run_2', 'run_3']);
  });

  it('lives in the reply message: [card, reply markdown], text = reply text; finished keeps the text', () => {
    const runs = [run(1, { status: 'running', details: 'Reading docs' })];
    const live = renderCard({ id: 4, title: null, frozen: false, replyText: 'On it — checking the docs.' }, runs);
    expect(live.blocks.map((b) => b.type)).toEqual(['plan', 'markdown']);
    expect((live.blocks[1] as any).text).toBe('On it — checking the docs.');
    expect(live.text).toBe('On it — checking the docs.');
    const frozen = renderCard({ id: 4, title: 'Checked the docs', frozen: true, replyText: 'On it — checking the docs.' }, [run(1, { status: 'complete', output: 'ok' })]);
    expect(frozen.blocks.map((b) => b.type)).toEqual(['plan', 'markdown']);
    expect((frozen.blocks[0] as any).title).toBe('Checked the docs');
    expect(frozen.text).toBe('On it — checking the docs.');
    // Over Slack's 12k markdown budget: rendered as rich_text (nothing cut), fallback text 3k.
    const long = renderCard({ id: 4, title: null, frozen: false, replyText: 'x'.repeat(20_000) }, runs);
    expect(long.blocks.map((b) => b.type)).toEqual(['plan', 'rich_text']);
    expect(long.text.length).toBe(3_000);
  });

  it('a reply with code keeps it as rich_text preformatted below the card, with stable block ids', () => {
    const replyText = 'Here:\n```html\n<h1>Hello, world!</h1>\n```\nMore soon.';
    const r = renderCard({ id: 5, title: null, frozen: false, replyText }, [run(1)]);
    expect(r.blocks.map((b) => b.type)).toEqual(['plan', 'markdown', 'rich_text', 'markdown']);
    expect(r.blocks.map((b) => (b as any).block_id)).toEqual(['card_5_plan', 'card_5_reply', 'card_5_reply_1', 'card_5_reply_2']);
    expect((r.blocks[2] as any).elements[0]).toEqual({ type: 'rich_text_preformatted', language: 'html', elements: [{ type: 'text', text: '<h1>Hello, world!</h1>' }] });
    expect(r.text).toBe(replyText);
  });

  it('keeps a chart between the reply and the buttons', () => {
    const chart = { type: 'data_visualization' as const, title: 'Signups', chart: { type: 'bar' as const, series: [{ name: 'N', data: [{ label: 'Mon', value: 1 }] }], axis_config: { categories: ['Mon'] } } };
    const r = renderCard({ id: 3, title: null, frozen: false, replyText: 'up this week', buttons: { id: 9, labels: ['A'] }, charts: [chart] }, [run(1)]);
    expect(r.blocks.map((b) => b.type)).toEqual(['plan', 'markdown', 'data_visualization', 'actions']);
    expect(r.blocks[2]).toMatchObject({ block_id: 'card_3_chart_1', title: 'Signups' });
    expect(r.text).toContain('up this week');
    expect(r.text).toContain('Signups (bar)');
  });
});

describe('turn steps on the card', () => {
  const steps = (...s: [string, 'in_progress' | 'complete' | 'error'][]) => s.map(([tool, status]) => ({ tool, status }));

  it('steps come first as tasks, then the runs, in one plan (one card per message)', () => {
    const r = renderCard({ id: 6, title: null, frozen: false, steps: steps(['slack_search', 'complete'], ['fetch_url', 'error']) }, [run(1, { status: 'running' })]);
    const plan = r.blocks[0] as any;
    expect(r.blocks.filter((b) => b.type === 'plan')).toHaveLength(1);
    expect(plan.title).toBe('Task 1');
    expect(plan.tasks.map((t: any) => [t.task_id, t.title, t.status])).toEqual([
      ['step_1', 'Searched Slack', 'complete'],
      ['step_2', 'Read a page', 'error'],
      ['run_1', 'Task 1', 'in_progress'],
    ]);
  });

  it('a step still running: the plan is live ("Working…"), with its live label', () => {
    const r = renderCard({ id: 6, title: null, frozen: false, steps: steps(['web_search', 'complete'], ['fetch_url', 'in_progress']) }, []);
    const plan = r.blocks[0] as any;
    expect(plan.type).toBe('plan');
    expect(plan.title).toBe('Working…');
    expect(plan.tasks.map((t: any) => t.title)).toEqual(['Searched the web', 'Reading the page…']);
  });

  it('once done, a steps-only card is a plan titled with the summary of its steps', () => {
    const r = renderCard(
      { id: 7, title: null, frozen: false, replyText: 'Here you go.', steps: steps(['slack_search', 'complete'], ['fetch_url', 'complete'], ['fetch_url', 'complete'], ['slack_search', 'complete']) },
      [],
    );
    expect(r.blocks.map((b) => b.type)).toEqual(['plan', 'markdown']);
    const plan = r.blocks[0] as any;
    expect(plan.title).toBe('Searched Slack twice, read 2 pages');
    expect(plan.tasks.map((t: any) => [t.title, t.status])).toEqual([
      ['Searched Slack', 'complete'],
      ['Read a page', 'complete'],
      ['Read a page', 'complete'],
      ['Searched Slack', 'complete'],
    ]);
  });

  it('a written-up card: its background title, else the summary of steps and runs; every step and run a task', () => {
    const runs = [run(1, { status: 'complete', output: 'ok' }), run(2, { status: 'error', error: 'x' }), run(3, { status: 'complete', output: 'ok' })];
    const card = { id: 8, frozen: true, steps: steps(['slack_search', 'complete'], ['fetch_url', 'complete'], ['fetch_url', 'complete']) };
    const untitled = renderCard({ ...card, title: null }, runs);
    expect((untitled.blocks[0] as any).title).toBe('Searched Slack, read 2 pages, worked on 3 tasks (1 failed)');
    const r = renderCard({ ...card, title: 'Compared frontend libraries' }, runs);
    const plan = r.blocks[0] as any;
    expect(plan.title).toBe('Compared frontend libraries');
    expect(plan.tasks.map((t: any) => [t.task_id, t.status])).toEqual([
      ['step_1', 'complete'],
      ['step_2', 'complete'],
      ['step_3', 'complete'],
      ['run_1', 'complete'],
      ['run_2', 'error'],
      ['run_3', 'complete'],
    ]);
    expect(r.text.split('\n')[0]).toBe('Compared frontend libraries');
  });
});

describe('card steps', () => {
  it('only work is a step: lookups, reads, files, canvases; not bookkeeping, responses or the subagent tools', async () => {
    const { isCardStep } = await import('./card-steps.js');
    for (const t of ['web_search', 'slack_search', 'fetch_url', 'read_thread', 'ask_thread', 'read_public_channel', 'read_file', 'ask_file', 'create_canvas']) expect(isCardStep(t)).toBe(true);
    for (const t of ['reply', 'react', 'remember', 'set_reminder', 'spawn_subagent', 'message_subagent', 'send_message', 'report_user', 'end_turn']) expect(isCardStep(t)).toBe(false);
  });

  it('summaries count and pluralise', async () => {
    const { summarizeSteps } = await import('./card-steps.js');
    const s = (tool: string) => ({ tool, status: 'complete' as const });
    expect(summarizeSteps([s('web_search'), s('web_search'), s('web_search')])).toBe('searched the web 3 times');
    expect(summarizeSteps([s('fetch_url')])).toBe('read a page');
    expect(summarizeSteps([s('read_thread'), s('ask_thread')])).toBe('read the thread twice');
    expect(summarizeSteps([], [{ status: 'complete' }])).toBe('worked on a task');
    expect(summarizeSteps([])).toBe('');
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
    // One run still going keeps the card expanded.
    const many = Array.from({ length: 60 }, (_, i) => run(i + 1, { status: i === 59 ? 'running' : 'complete', output: `Result ${i + 1}`, result: longResult, sources: [{ url: 'https://example.com/x' }] }));
    const { blocks } = renderCard({ id: 1, title: null, frozen: false }, many);
    const plan = blocks[0] as any;
    expect(plan.tasks).toHaveLength(50);
    expect(plan.tasks[0].task_id).toBe('run_11');
    // Summary only, no sources, with many runs.
    expect(plan.tasks[0].output.elements).toHaveLength(1);
    expect(plan.tasks[0].sources).toBeUndefined();
    expect(JSON.stringify(blocks).length).toBeLessThan(20_000);
    const four = renderCard({ id: 1, title: null, frozen: false }, [...many.slice(0, 3), run(99, { status: 'running' })]);
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

/** Every text element anywhere in `x` (rich text sections, lists, links' labels). */
function textElements(x: any, out: any[] = []): any[] {
  if (Array.isArray(x)) x.forEach((y) => textElements(y, out));
  else if (x && typeof x === 'object') {
    if (x.type === 'text') out.push(x);
    for (const v of Object.values(x)) if (v && typeof v === 'object') textElements(v, out);
  }
  return out;
}

describe('no empty text elements (Slack rejects the card: invalid_blocks, "must be more than 0 characters")', () => {
  it('a list item cut where only whitespace is left drops the empty piece', () => {
    // The cut lands on " tail": the slice is whitespace, trimmed to "" (it used to be sent as an empty element).
    const md = '- **one two** tail end\n- next item';
    for (let max = 1; max <= 24; max++) {
      const els = markdownToRich(md, { maxChars: max, maxLines: 8 });
      for (const e of textElements(els)) expect(e.text.length, `maxChars ${max}`).toBeGreaterThan(0);
    }
    const cut = markdownToRich(md, { maxChars: 8, maxLines: 8 }) as any;
    expect(cut[0].type).toBe('rich_text_list');
    expect(cut[0].elements[0].elements).toEqual([{ type: 'text', text: 'one two', style: { bold: true } }, { type: 'text', text: '…' }]);
  });

  it('blank lines, blank headings and blank-edged sections leave nothing empty; separators between words stay', () => {
    const els = markdownToRich('# **\n\n- **a** **b**\n-  \n[ ](https://example.com/x)', { maxChars: 600, maxLines: 8 }) as any;
    for (const e of textElements(els)) expect(e.text.trim().length > 0 || e.text === ' ' || e.text === '\n').toBe(true);
    expect(els[0].elements[0].elements).toEqual([
      { type: 'text', text: 'a', style: { bold: true } },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'b', style: { bold: true } },
    ]);
    // A link with a blank label shows its url instead.
    expect(JSON.stringify(els)).toContain('{"type":"link","url":"https://example.com/x"}');
    expect(cleanInlines([{ type: 'text', text: '' }, { type: 'text', text: '  ', style: { bold: true } }])).toEqual([]);
  });

  it('a subagent whose output, result, error, details or title are blank still renders a valid task', () => {
    const blank = [
      run(1, { status: 'complete', output: '   ', result: '\n \n' }),
      run(2, { status: 'complete', output: 'Found it', result: '**  **\n# **\n' }),
      run(3, { status: 'error', error: '  ' }),
      run(4, { status: 'running', details: ' ', steerNotes: ['  '] }),
      run(5, { status: 'complete', subagentTitle: '  ', output: 'ok', sources: [{ url: '' }, { url: 'https://example.com/' }] }),
    ];
    const { blocks } = renderCard({ id: 3, title: null, frozen: false }, blank);
    const tasks = (blocks[0] as any).tasks;
    for (const e of textElements(tasks)) expect(e.text.length).toBeGreaterThan(0);
    expect(textOf(tasks[0].output)).toBe('Done');
    expect(tasks[1].output.elements).toHaveLength(1); // nothing visible in the result: the summary alone
    expect(textOf(tasks[2].output)).toBe('Failed');
    expect(textOf(tasks[3].details)).toBe('Working…');
    expect(tasks[4].title).toBe('Task');
    expect(tasks[4].sources).toEqual([{ type: 'url', url: 'https://example.com/', text: 'example.com' }]);
  });
});
