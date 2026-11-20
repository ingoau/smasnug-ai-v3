import { describe, expect, it } from 'vitest';
import { buildExtras, cardExtras, cardsSchema, clipMrkdwn, containerExtras, containersSchema, degradedFileIds, extrasFallback, fieldExtras, fieldsSchema, imageExtras, linkExtras, linksSchema, mrkdwn, parseExtras, replyBody, responseTimeFooter, serializeExtras, tableExtras, urlImage } from './rich-blocks.js';

describe('tableExtras', () => {
  it('pads short rows, names missing headers, numbers sort as numbers, empty cells get a dash', () => {
    const { items, notes } = tableExtras({ caption: 'T', columns: ['A'], rows: [['x', 3, '4.5'], ['', null]] });
    expect(notes).toEqual([]);
    const rows = (items[0]!.block as any).rows;
    expect(rows[0].map((c: any) => c.text)).toEqual(['A', 'Column 2', 'Column 3']);
    expect(rows[1]).toEqual([{ type: 'raw_text', text: 'x' }, { type: 'raw_number', value: 3, text: '3' }, { type: 'raw_number', value: 4.5, text: '4.5' }]);
    expect(rows[2].map((c: any) => c.text)).toEqual(['–', '–', '–']);
    expect(items[0]!.block).toMatchObject({ type: 'data_table', caption: 'T', page_size: 2 });
  });

  it('applies the row cap and the per-message character budget, with notes; refs keep the list position', () => {
    const many = Array.from({ length: 250 }, (_, i) => [`r${i}`]);
    const r = tableExtras([{ caption: 'bad' }, { caption: 'Big', columns: ['c'], rows: many }]);
    expect(r.items.map((i) => i.ref)).toEqual(['table:2']);
    expect((r.items[0]!.block as any).rows).toHaveLength(201);
    expect(r.notes.join(' ')).toMatch(/Dropped table "bad".*first 200 of 250 rows/);
    const long = Array.from({ length: 50 }, () => ['x'.repeat(500)]);
    const b = tableExtras({ caption: 'Long', columns: ['c'], rows: long });
    expect((b.items[0]!.block as any).rows.length).toBeLessThan(40);
  });

  it('neutralises group pings and keeps the markdown fallback valid', () => {
    const { items } = tableExtras({ caption: 'hi @channel', columns: ['a|b'], rows: [['<!here> [x]']] });
    expect(JSON.stringify(items[0]!.block)).not.toMatch(/<!here>|(^|[^​])@channel/);
    expect(items[0]!.fallback).toContain('| a\\|b |');
  });
});

describe('cardExtras', () => {
  it('one card stands alone, several make a carousel; links get a button; untitled + bodiless cards are dropped', () => {
    const one = cardExtras([{ title: 'A', url: 'https://a.example', button: 'Visit' }]);
    expect(one.items[0]!.block).toMatchObject({ type: 'card', title: { type: 'plain_text', text: 'A' }, actions: [{ type: 'button', url: 'https://a.example/', text: { text: 'Visit' } }] });
    expect((one.items[0]!.block as any).block_id).toBeUndefined();
    const many = cardExtras([{ title: 'A' }, {}, { body: 'B', image_url: 'javascript:alert(1)' }]);
    expect(many.items[0]!.block).toMatchObject({ type: 'carousel' });
    expect((many.items[0]!.block as any).elements).toHaveLength(2);
    expect((many.items[0]!.block as any).elements[1].hero_image).toBeUndefined();
    expect(many.notes).toEqual(['Dropped a card with neither title nor body.']);
  });
});

describe('images', () => {
  it('file images use slack_file, URL images image_url; only http(s) URLs', () => {
    const items = imageExtras([{ n: 2, slackFileId: 'F1', alt: 'cat', title: 'Cat' }, { url: 'https://e.example/x.png', alt: '' }]);
    expect(items[0]).toMatchObject({ ref: 'image:2', slackFileId: 'F1', fallback: '', block: { slack_file: { id: 'F1' }, title: { type: 'plain_text', text: 'Cat' } } });
    expect(items[1]).toMatchObject({ ref: 'image:2', fallback: '[image](https://e.example/x.png)', block: { image_url: 'https://e.example/x.png', alt_text: 'image' } });
    expect(urlImage({ url: 'file:///etc/passwd' })).toMatch(/not an http/);
  });
});

describe('replyBody', () => {
  const { extras } = buildExtras({
    charts: [{ title: 'Pie', type: 'pie', segments: [{ label: 'a', value: 1 }] }],
    images: [{ slackFileId: 'F1', alt: 'cat' }],
    tables: { caption: 'T', columns: ['a'], rows: [['1']] },
  });

  it('inline where a marker is, the rest below in order, ids from the prefix; unknown or repeated markers dropped', () => {
    const blocks = replyBody('Intro\n[[table]]\n[[table]]\n[[cards]]\nEnd', extras, { maxBlocks: 49, idPrefix: 'card_7_' }) as any[];
    expect(blocks.map((b) => b.block_id ?? b.type)).toEqual(['markdown', 'card_7_table_1', 'markdown', 'card_7_chart_1', 'card_7_image_1']);
  });

  it('a placed extra that does not fit in the folded text still goes below it', () => {
    const text = [...Array.from({ length: 12 }, (_, i) => `p${i}\n\n\`\`\`\ncode ${i}\n\`\`\``), '[[table]]', 'end'].join('\n\n');
    const blocks = replyBody(text, extras, { maxBlocks: 10, idPrefix: '' }) as any[];
    expect(blocks.length).toBeLessThanOrEqual(10);
    expect(blocks.map((b) => b.block_id).filter(Boolean)).toEqual(expect.arrayContaining(['table_1', 'chart_1', 'image_1']));
  });

  it('never drops an extra when the fold moves on the second render', () => {
    const { extras: x } = buildExtras({
      tables: [{ caption: 'A', columns: ['a'], rows: [['1']] }, { caption: 'B', columns: ['b'], rows: [['2']] }],
      cards: [{ title: 'c', url: 'https://c.example' }],
    });
    for (let at = 0; at <= 14; at++) {
      const paras = Array.from({ length: 14 }, (_, i) => `p${i}\n\n\`\`\`\ncode ${i}\n\`\`\``);
      paras.splice(at, 0, '[[table:1]]', '[[table:2]]');
      const blocks = replyBody([...paras, '[[cards]]'].join('\n\n'), x, { maxBlocks: 10, idPrefix: '' }) as any[];
      expect(blocks.length).toBeLessThanOrEqual(10);
      expect(blocks.map((b) => b.block_id).filter(Boolean).sort(), `at ${at}`).toEqual(['cards_1', 'table_1', 'table_2']);
    }
  });

  it('degraded fallbacks can never smuggle in a marker line', () => {
    const { extras: x } = buildExtras({ tables: { caption: 'T', columns: ['a'], rows: [['1']] }, cards: [{ title: 'c', body: '[[table:1]]' }] });
    const md = (replyBody('hi', { ...x, degraded: true }, { maxBlocks: 49, idPrefix: '' }) as any[]).map((b) => b.text).join('\n');
    expect(md.match(/\| a \|/g)).toHaveLength(1);
    expect(md).not.toContain('[[');
  });

  it('extras only: no empty markdown block', () => {
    expect((replyBody('  ', extras, { maxBlocks: 49, idPrefix: '' }) as any[]).map((b) => b.type)).toEqual(['data_visualization', 'image', 'data_table']);
  });

  it('degraded: fallbacks inline / below as markdown, file images to attach instead', () => {
    const d = { ...extras, degraded: true };
    const blocks = replyBody('Intro\n[[table]]\nEnd', d, { maxBlocks: 49, idPrefix: '' }) as any[];
    expect(blocks.every((b) => b.type === 'markdown')).toBe(true);
    const md = blocks.map((b) => b.text).join('\n');
    expect(md.indexOf('| a |')).toBeLessThan(md.indexOf('End'));
    expect(md).toContain('Pie (pie): a 1');
    expect(degradedFileIds(d)).toEqual(['F1']);
    expect(degradedFileIds(extras)).toEqual([]);
  });

  it('fallback text drops marker lines and lists the extras', () => {
    expect(extrasFallback('Hi\n[[image]]\nthere', extras)).toBe('Hi\nthere\nPie (pie): a 1\n[image: cat]\n[table: T, 1 rows]');
  });

  it('round-trips through storage (degraded flag included); junk is ignored', () => {
    expect(parseExtras(serializeExtras({ ...extras, degraded: true }))).toEqual({ ...extras, degraded: true });
    expect(parseExtras('{"items":[{"ref":1}]}')).toEqual({ items: [] });
    expect(parseExtras('nope')).toBeNull();
    expect(parseExtras(null)).toBeNull();
  });
});

describe('response time footer', () => {
  it('formats durations', async () => {
    const { formatDuration } = await import('./rich-blocks.js');
    expect(formatDuration(840)).toBe('0.8s');
    expect(formatDuration(9_949)).toBe('9.9s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(59_700)).toBe('1m 00s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3_780_000)).toBe('1h 03m');
    expect(formatDuration(-50)).toBe('0.0s');
  });

  it('survives storage and renders as the last context block', async () => {
    const { footerBlock, hasExtras } = await import('./rich-blocks.js');
    const back = parseExtras(serializeExtras({ items: [], footer: 'Responded in 3.0s' }));
    expect(back).toEqual({ items: [], footer: 'Responded in 3.0s' });
    expect(hasExtras(back)).toBe(true);
    expect(hasExtras({ items: [] })).toBe(false);
    expect(footerBlock(back, 'card_1_')).toEqual([{ type: 'context', block_id: 'card_1_reply_footer', elements: [{ type: 'mrkdwn', text: 'Responded in 3.0s' }] }]);
  });
});

describe('mrkdwn', () => {
  it('converts bold, strike and links, escapes &<>, keeps Slack links and mentions', () => {
    expect(mrkdwn('**a** ~~b~~ [x](https://e.com/a) <https://s.com|s> <@U1> 1 < 2 & 3')).toBe('*a* ~b~ <https://e.com/a|x> <https://s.com|s> <@U1> 1 &lt; 2 &amp; 3');
  });
});

describe('responseTimeFooter', () => {
  it('names a fallback model', () => {
    expect(responseTimeFooter(1500)).toBe('Responded in 1.5s');
    expect(responseTimeFooter(1500, 'GPT-6 Luna')).toBe('Responded in 1.5s · via GPT-6 Luna (fallback)');
  });
});

describe('cardExtras: icon and buttons', () => {
  it('adds an icon and up to 3 link buttons; the older url/button pair still works', () => {
    const { items, notes } = cardExtras([
      { title: 'A', icon_url: 'https://e.com/i.png', buttons: [{ label: 'One', url: 'https://e.com/1' }, { label: 'Two', url: 'https://e.com/2', style: 'primary' }, { label: 'Bad' }, { label: 'Three', url: 'https://e.com/3' }, { label: 'Four', url: 'https://e.com/4' }] },
      { title: 'B', url: 'https://e.com/b', button: 'Go' },
    ]);
    const [a, b] = (items[0]!.block as any).elements;
    expect(a.icon).toEqual({ type: 'image', image_url: 'https://e.com/i.png', alt_text: 'A icon' });
    expect(a.actions.map((x: any) => [x.text.text, x.action_id])).toEqual([
      ['One', 'link:card_1'],
      ['Two', 'link:card_1_2'],
      ['Three', 'link:card_1_3'],
    ]);
    expect(a.actions[1].style).toBe('primary');
    expect(b.actions).toEqual([{ type: 'button', text: { type: 'plain_text', text: 'Go' }, url: 'https://e.com/b', action_id: 'link:card_2' }]);
    expect(notes.join(' ')).toMatch(/Bad.*url/);
    expect(notes.join(' ')).toMatch(/Only 3 buttons/);
    expect(items[0]!.fallback).toContain('[Two](https://e.com/2)');
  });
});

describe('fieldExtras', () => {
  it('makes a section with two-column fields and a bold title', () => {
    const { items } = fieldExtras([{ title: 'Status', items: [{ label: 'Owner', value: '**Ana**' }, { label: 'Due', value: 'Friday' }, {}] }]);
    expect(items[0]!.ref).toBe('fields:1');
    expect(items[0]!.block).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Status*' },
      fields: [
        { type: 'mrkdwn', text: '*Owner*\n*Ana*' },
        { type: 'mrkdwn', text: '*Due*\nFriday' },
      ],
    });
    expect(items[0]!.fallback).toBe('**Status**\n- **Owner:** **Ana**\n- **Due:** Friday');
  });
  it('drops an empty group with a note', () => {
    const { items, notes } = fieldExtras([{ title: 'x', items: [] }]);
    expect(items).toEqual([]);
    expect(notes[0]).toMatch(/no items/);
  });
});

describe('linkExtras', () => {
  it('makes one actions block per row; a flat list is one row', () => {
    const rows = linkExtras([[{ label: 'Docs', url: 'https://d.com' }], [{ label: 'x' }]]);
    expect(rows.items.map((i) => i.ref)).toEqual(['links:1']);
    expect(rows.items[0]!.block).toEqual({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Docs' }, url: 'https://d.com/', action_id: 'link:links_1_1' }] });
    const flat = linkExtras([{ label: 'A', url: 'https://a.com' }, { label: 'B', url: 'https://b.com' }]);
    expect(flat.items).toHaveLength(1);
    expect((flat.items[0]!.block as any).elements).toHaveLength(2);
    expect(flat.items[0]!.fallback).toBe('[A](https://a.com/) · [B](https://b.com/)');
  });
});

describe('containerExtras', () => {
  it('collapsible by default, collapsed, box and plain styles', () => {
    const { items } = containerExtras([
      { title: 'Details', body: 'long **text**' },
      { style: 'collapsed', title: 'Logs', body: 'x' },
      { style: 'box', title: 'Box', body: 'y', width: 'wide' },
      { style: 'plain', title: 'Plain', fields: [{ label: 'k', value: 'v' }], buttons: [{ label: 'Open', url: 'https://o.com' }] },
    ]);
    const [a, b, c, d] = items.map((i) => i.block as any);
    expect(a).toMatchObject({ type: 'container', title: { type: 'plain_text', text: 'Details' }, is_collapsible: true, child_blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'long *text*' } }] });
    expect(a.default_collapsed).toBeUndefined();
    expect(b).toMatchObject({ is_collapsible: true, default_collapsed: true });
    expect(c).toMatchObject({ has_header_divider: true, width: 'wide' });
    expect(c.is_collapsible).toBeUndefined();
    expect(d.is_collapsible).toBeUndefined();
    expect(d.has_header_divider).toBeUndefined();
    expect(d.child_blocks.map((x: any) => x.type)).toEqual(['section', 'actions']);
    expect(items.map((i) => i.ref)).toEqual(['container:1', 'container:2', 'container:3', 'container:4']);
  });
  it('alert styles become alert blocks', () => {
    const { items } = containerExtras([{ style: 'warning', title: 'Heads up', body: 'it **breaks**' }]);
    expect(items[0]!.block).toEqual({ type: 'alert', level: 'warning', text: { type: 'mrkdwn', text: '*Heads up*\nit *breaks*' } });
    expect(items[0]!.fallback).toBe('> **Heads up**\n> it **breaks**');
  });
  it('needs a title (non-alerts) and content; long bodies are split into sections', () => {
    const { items, notes } = containerExtras([{ body: 'x' }, { title: 'Empty' }, { title: 'Long', body: `${'a'.repeat(2900)}\n\n${'b'.repeat(2900)}` }]);
    expect(items).toHaveLength(1);
    expect((items[0]!.block as any).child_blocks).toHaveLength(2);
    expect(notes.join(' ')).toMatch(/needs a title/);
    expect(notes.join(' ')).toMatch(/no content/);
  });
});

describe('replyBody: dividers and placed buttons', () => {
  const buttons = { type: 'actions', block_id: 'reply_1_buttons', elements: [] };
  it('puts the buttons where [[buttons]] is, dividers at [[divider]]', () => {
    const blocks = replyBody('Pick one?\n[[buttons]]\n[[divider]]\nMore\n[[divider]]\nEnd', null, { maxBlocks: 10, idPrefix: 'p_', buttons }) as any[];
    expect(blocks.map((b) => b.type)).toEqual(['markdown', 'actions', 'divider', 'markdown', 'divider', 'markdown']);
    expect(blocks[1]).toBe(buttons);
    expect(blocks[2].block_id).toBe('p_divider_1');
    expect(blocks[4].block_id).toBe('p_divider_2');
  });
  it('buttons go last when not placed, and a [[buttons]] line without buttons shows nothing', () => {
    const extras = buildExtras({ fields: [{ items: [{ label: 'a', value: 'b' }] }] }).extras;
    const blocks = replyBody('Hi', extras, { maxBlocks: 10, idPrefix: '', buttons }) as any[];
    expect(blocks.map((b) => b.type)).toEqual(['markdown', 'section', 'actions']);
    expect((replyBody('Hi\n[[buttons]]', null, { maxBlocks: 10, idPrefix: '' }) as any[]).map((b) => b.type)).toEqual(['markdown']);
  });
  it('keeps placed buttons in a degraded render', () => {
    const extras = { ...buildExtras({ containers: [{ title: 'T', body: 'b' }] }).extras, degraded: true };
    const blocks = replyBody('Q?\n[[buttons]]\nrest', extras, { maxBlocks: 10, idPrefix: '', buttons }) as any[];
    expect(blocks.map((b) => b.type)).toEqual(['markdown', 'actions', 'markdown']);
    expect(blocks[2].text).toContain('**T**');
  });
  it('places fields, links and containers by marker', () => {
    const extras = buildExtras({ fields: [{ items: [{ label: 'a', value: 'b' }] }], links: [[{ label: 'L', url: 'https://l.com' }]], containers: [{ title: 'C', body: 'c' }] }).extras;
    const blocks = replyBody('A\n[[links:1]]\nB\n[[fields:1]]\n[[container:1]]\nZ', extras, { maxBlocks: 10, idPrefix: '' }) as any[];
    expect(blocks.map((b) => b.type)).toEqual(['markdown', 'actions', 'markdown', 'section', 'container', 'markdown']);
  });
});

describe('review fixes', () => {
  it('schemas take a single object, nulls, the flat links form and alias keys', () => {
    const c = containersSchema.parse({ title: 'D', text: 'body', kind: 'collapsed', style: null, width: null });
    const ci = containerExtras(c).items;
    expect(ci).toHaveLength(1);
    expect(ci[0]!.block).toMatchObject({ default_collapsed: true, child_blocks: [{ text: { text: 'body' } }] });
    expect(fieldExtras(fieldsSchema.parse({ fields: [{ key: 'k', value: 'v' }] })).items).toHaveLength(1);
    expect(cardExtras(cardsSchema.parse([{ title: 'X', url: 'https://x.com', icon_url: null }])).items).toHaveLength(1);
    const flat = linkExtras(linksSchema.parse([{ label: 'Docs', url: 'https://x.com' }]));
    expect(flat.items).toHaveLength(1);
    expect(linksSchema.parse('nope')).toEqual(['nope']);
    expect(linkExtras(linksSchema.parse([{ buttons: [{ label: 'A', url: 'https://a.com', style: null }] }])).items).toHaveLength(1);
  });
  it('mrkdwn leaves code alone and keeps parenthesised URLs', () => {
    expect(mrkdwn('`obj.__init__()` and ```a**2 + b**2```')).toBe('`obj.__init__()` and ```a**2 + b**2```');
    expect(mrkdwn('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('<https://en.wikipedia.org/wiki/Foo_(bar)|wiki>');
    expect(mrkdwn('`a<b`')).toBe('`a&lt;b`');
  });
  it('clipMrkdwn never splits an entity or a link', () => {
    expect(clipMrkdwn('abc &amp; def', 7)).toBe('abc…');
    expect(clipMrkdwn('x <https://a.com|a> y', 10)).toBe('x…');
  });
  const buttons = { type: 'actions', block_id: 'reply_1_buttons', elements: [] };
  const long = Array.from({ length: 30 }, (_, i) => `para ${i}\n\n\`\`\`\ncode ${i}\n\`\`\``).join('\n\n');
  it('a placed [[buttons]] that folds away keeps every bit of text and the row', () => {
    const blocks = replyBody(`${long}\n\n[[buttons]]\n\nLAST LINE`, null, { maxBlocks: 47, idPrefix: '', buttons }) as any[];
    expect(blocks.length).toBeLessThanOrEqual(48);
    expect(blocks.filter((b) => b === buttons)).toHaveLength(1);
    expect(JSON.stringify(blocks)).toContain('LAST LINE');
    expect(JSON.stringify(blocks)).toContain('para 29');
  });
  it('degraded with buttons stays within maxBlocks + the row', () => {
    const extras = { items: [], degraded: true };
    const blocks = replyBody(long, extras, { maxBlocks: 47, idPrefix: '', buttons }) as any[];
    expect(blocks.length).toBeLessThanOrEqual(48);
    expect(blocks.at(-1)).toBe(buttons);
  });
});
