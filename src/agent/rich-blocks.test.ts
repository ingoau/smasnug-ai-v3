import { describe, expect, it } from 'vitest';
import { buildExtras, cardExtras, degradedFileIds, extrasFallback, imageExtras, parseExtras, replyBody, serializeExtras, tableExtras, urlImage } from './rich-blocks.js';

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
