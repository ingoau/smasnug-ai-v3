import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_BUDGET,
  MAX_MESSAGE_BLOCKS,
  blocksText,
  escapeAffectedTags,
  mdDisplay,
  replyBlocks,
  replyMessage,
  splitMarkdown,
  streamArgsText,
  streamUnits,
  type ReplyBlock,
  type StreamUnit,
} from './slack-markdown.js';

const preformatted = (blocks: ReplyBlock[]) =>
  blocks.flatMap((b) => (b.type === 'rich_text' ? b.elements.filter((e) => e.type === 'rich_text_preformatted') : []));

describe('splitMarkdown: fenced code', () => {
  it('splits a ```lang fence out of prose, raw code kept exactly', () => {
    const text = 'Here is a page:\n\n```html\n<h1>Hello, world!</h1>\n<img src="y">\n<code>i</code>\n```\n\nDone.';
    expect(splitMarkdown(text)).toEqual([
      { kind: 'markdown', text: 'Here is a page:' },
      { kind: 'code', code: '<h1>Hello, world!</h1>\n<img src="y">\n<code>i</code>', language: 'html' },
      { kind: 'markdown', text: 'Done.' },
    ]);
  });

  it('a fence without a language gets "text"; ~~~ fences work', () => {
    expect(splitMarkdown('```\n<h2>x</h2>\n```')).toEqual([{ kind: 'code', code: '<h2>x</h2>', language: 'text' }]);
    expect(splitMarkdown('~~~python extra info\nprint("<h3>")\n~~~')).toEqual([{ kind: 'code', code: 'print("<h3>")', language: 'python' }]);
  });

  it('nested backticks: a longer fence contains shorter ones; backticks inside code lines are content', () => {
    const text = '````md\n```js\nconst s = `<h1>${x}</h1>`;\n```\n````';
    expect(splitMarkdown(text)).toEqual([{ kind: 'code', code: '```js\nconst s = `<h1>${x}</h1>`;\n```', language: 'md' }]);
    // A ~~~ line doesn't close a ``` fence, a shorter run doesn't close a longer one.
    expect(splitMarkdown('```\na\n~~~\n``\nb\n```')).toEqual([{ kind: 'code', code: 'a\n~~~\n``\nb', language: 'text' }]);
  });

  it('indented fences (inside list items) are dedented by the fence indent', () => {
    const text = '1. Install:\n   ```bash\n   npm i\n     --save\n   ```\n2. Run it';
    expect(splitMarkdown(text)).toEqual([
      { kind: 'markdown', text: '1. Install:' },
      { kind: 'code', code: 'npm i\n  --save', language: 'bash' },
      { kind: 'markdown', text: '2. Run it' },
    ]);
  });

  it('an unclosed fence runs to the end', () => {
    expect(splitMarkdown('See:\n```js\nlet a = 1;')).toEqual([
      { kind: 'markdown', text: 'See:' },
      { kind: 'code', code: 'let a = 1;', language: 'js' },
    ]);
  });

  it('inline triple backticks are not a fence', () => {
    expect(splitMarkdown('Use ```code``` here')).toEqual([{ kind: 'markdown', text: 'Use ```code``` here' }]);
  });
});

describe('splitMarkdown: prose', () => {
  it('tables, bold, links and lists stay markdown, untouched', () => {
    const text = '| Tag | Use |\n|---|---|\n| `<b>` | **bold** |\n\n- [docs](https://x.dev)\n- <a href="z">x</a> & <br>';
    expect(splitMarkdown(text)).toEqual([{ kind: 'markdown', text }]);
    expect(replyBlocks(text)).toEqual([{ type: 'markdown', text }]);
  });

  it('affected tags in prose: only their `<` becomes &lt; (renders literally in prose)', () => {
    expect(escapeAffectedTags('Use <h1>Title</h1>, <IMG src=a>, <code>x</code>, <b>, <header>, a < b')).toBe(
      'Use &lt;h1>Title&lt;/h1>, &lt;IMG src=a>, &lt;code>x&lt;/code>, <b>, <header>, a < b',
    );
    expect(escapeAffectedTags('escaped \\<h2>')).toBe('escaped &lt;h2>');
    expect(replyBlocks('Wrap it in <h1>…</h1>.')).toEqual([{ type: 'markdown', text: 'Wrap it in &lt;h1>…&lt;/h1>.' }]);
  });

  it('a paragraph with an affected tag in inline code becomes rich_text with literal code text', () => {
    const text = 'Intro paragraph.\n\nUse the `<h1>` tag for **titles**, see [MDN](https://developer.mozilla.org).\n\n| a | b |\n|---|---|';
    const segs = splitMarkdown(text);
    expect(segs.map((s) => s.kind)).toEqual(['markdown', 'rich', 'markdown']);
    const blocks = replyBlocks(text);
    expect(blocks[0]).toEqual({ type: 'markdown', text: 'Intro paragraph.' });
    expect(blocks[1]).toEqual({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'Use the ' },
            { type: 'text', text: '<h1>', style: { code: true } },
            { type: 'text', text: ' tag for ' },
            { type: 'text', text: 'titles', style: { bold: true } },
            { type: 'text', text: ', see ' },
            { type: 'link', url: 'https://developer.mozilla.org', text: 'MDN' },
            { type: 'text', text: '.' },
          ],
        },
      ],
    });
    expect(blocks[2]).toEqual({ type: 'markdown', text: '| a | b |\n|---|---|' });
  });

  it('inline code without affected tags stays markdown', () => {
    expect(splitMarkdown('Use `<b>` or ``a`b``.')).toEqual([{ kind: 'markdown', text: 'Use `<b>` or ``a`b``.' }]);
  });

  it('rich paragraphs keep lists, headings and quotes readable', () => {
    const blocks = replyBlocks('## Tags `<h2>`\n- `<img>` embeds\n  - nested\n3. third `<code>`\n> quote `<h1>`');
    expect(blocks).toHaveLength(1);
    const els = (blocks[0] as any).elements;
    expect(els.map((e: any) => e.type)).toEqual(['rich_text_section', 'rich_text_list', 'rich_text_list', 'rich_text_list', 'rich_text_quote']);
    expect(els[0].elements[0]).toEqual({ type: 'text', text: 'Tags ', style: { bold: true } });
    expect(els[2]).toMatchObject({ style: 'bullet', indent: 1 });
    expect(els[3]).toMatchObject({ style: 'ordered', offset: 2 });
  });
});

describe('replyBlocks: code as rich_text preformatted', () => {
  it('every preformatted element has a language (rich code component in Slack)', () => {
    const text = 'a\n```\nplain\n```\nb\n```ts\nlet x: number;\n```\n~~~\nc\n~~~\n```py\n```';
    const pre = preformatted(replyBlocks(text));
    expect(pre).toHaveLength(4);
    for (const p of pre) expect(p.language).toMatch(/\S/);
    expect(pre.map((p) => p.language)).toEqual(['text', 'ts', 'text', 'py']);
    expect(pre[3]!.elements[0]!.text).toBe(' '); // empty code: Slack needs non-empty text
  });

  it('the html example reaches Slack exactly as written', () => {
    const msg = replyMessage('```html\n<h1>Hello, world!</h1>\n```');
    expect(msg.blocks).toEqual([
      { type: 'rich_text', elements: [{ type: 'rich_text_preformatted', language: 'html', elements: [{ type: 'text', text: '<h1>Hello, world!</h1>' }] }] },
    ]);
    expect(msg.text).toBe('```html\n<h1>Hello, world!</h1>\n```'); // fallback = raw text
  });

  it('too many blocks: the tail merges into one rich_text block', () => {
    const text = Array.from({ length: 60 }, (_, i) => `step ${i}\n\`\`\`\ncode ${i}\n\`\`\``).join('\n');
    const blocks = replyBlocks(text, { maxBlocks: 48 });
    expect(blocks).toHaveLength(48);
    const last = blocks.at(-1) as any;
    expect(last.type).toBe('rich_text');
    expect(last.elements.filter((e: any) => e.type === 'rich_text_preformatted').length).toBeGreaterThan(30);
    expect(preformatted(blocks).every((p) => p.language)).toBe(true);
    expect(replyBlocks(text).length).toBe(MAX_MESSAGE_BLOCKS);
  });

  it('markdown over the shared 12k budget is rendered as rich_text instead of cut', () => {
    const para = 'word '.repeat(1500).trim(); // 7.5k chars
    const text = `${para}\n\`\`\`\nx\n\`\`\`\n${para}`;
    const blocks = replyBlocks(text);
    expect(blocks.map((b) => b.type)).toEqual(['markdown', 'rich_text', 'rich_text']);
    const md = blocks.filter((b) => b.type === 'markdown').reduce((n, b) => n + (b as any).text.length, 0);
    expect(md).toBeLessThanOrEqual(MARKDOWN_BUDGET);
  });
});

/** Every complete unit of a prefix equals the final unit; the growing last markdown unit only extends. */
function expectPrefixStable(text: string) {
  const final = streamUnits(text, true);
  const same = (a: StreamUnit, b: StreamUnit) => JSON.stringify(a) === JSON.stringify(b);
  for (let k = 0; k <= text.length; k++) {
    const part = text.slice(0, k);
    const units = streamUnits(part, false);
    units.forEach((u, i) => {
      const f = final[i];
      expect(f, `prefix ${k}, unit ${i}`).toBeDefined();
      if (u.kind === 'md' && i === units.length - 1) {
        expect(f!.kind).toBe('md');
        expect(f!.start).toBe(u.start);
        expect(mdDisplay(text.slice(f!.start, f!.end)).startsWith(mdDisplay(part.slice(u.start, u.end))), `prefix ${k}`).toBe(true);
      } else expect(same(u, f!), `prefix ${k}, unit ${i}: ${JSON.stringify(u)} vs ${JSON.stringify(f)}`).toBe(true);
    });
  }
  return final;
}

describe('streamUnits', () => {
  it('holds a code block until its fence closes, then emits it whole', () => {
    const text = 'Sure:\n```html\n<h1>Hello, world!</h1>\n```\nThat is it.';
    expect(streamUnits('Sure:\n```html\n<h1>Hel', false)).toEqual([{ kind: 'md', start: 0, end: 6 }]);
    expect(streamUnits('Sure:\n```html\n<h1>Hello, world!</h1>\n```', false)).toEqual([{ kind: 'md', start: 0, end: 6 }]); // closing line not complete
    const units = expectPrefixStable(text);
    expect(units.map((u) => u.kind)).toEqual(['md', 'block', 'md']);
    expect((units[1] as any).seg).toEqual({ kind: 'code', code: '<h1>Hello, world!</h1>', language: 'html' });
    expect(mdDisplay(text.slice(units[2]!.start, units[2]!.end))).toBe('That is it.');
  });

  it('holds a partial line that may become a fence, but not ordinary inline code', () => {
    expect(streamUnits('Hi\n``', false)).toEqual([{ kind: 'md', start: 0, end: 3 }]);
    expect(streamUnits('Hi\n```j', false)).toEqual([{ kind: 'md', start: 0, end: 3 }]);
    expect(streamUnits('Hi\n`x` is fine', false)).toEqual([{ kind: 'md', start: 0, end: 14 }]);
  });

  it('holds an open inline code span and a trailing `<` until they resolve', () => {
    expect(streamUnits('Use `<h', false)).toEqual([{ kind: 'md', start: 0, end: 4 }]);
    expect(streamUnits('Write <h', false)).toEqual([{ kind: 'md', start: 0, end: 6 }]);
    expect(streamUnits('Write \\', false)).toEqual([{ kind: 'md', start: 0, end: 6 }]);
  });

  it('prefix-stable across many shapes (fences, ~~~, nested backticks, inline <h1>, tables)', () => {
    const texts = [
      'Intro.\n\n```js\nconst a = `x`;\n```\n\nThen `<h1>` inline and **bold**.\n\nNext para <h2>t</h2> & <b>.',
      '~~~\n<img src="y">\n~~~\n| a | b |\n|---|---|\n| `<code>` | 2 |\n\nend',
      '````md\n```html\n<h1>x</h1>\n```\n````\ntrailing ``code `with` ticks`` ok',
      '1. a\n   ```bash\n   ls\n   ```\n2. b `<h3>` c\n3. d',
      'no fences at all, just `a` and `<b>` and \\<h1>',
      'unclosed `tick and more text\n\nnew para',
    ];
    for (const t of texts) expectPrefixStable(t);
  });

  it('an affected inline code span cuts the paragraph: text before it streams as markdown, the rest is a block', () => {
    const text = 'Use the `<h1>` tag.\n\nNext.';
    const units = expectPrefixStable(text);
    expect(units.map((u) => u.kind)).toEqual(['md', 'block', 'md']);
    expect(text.slice(units[0]!.start, units[0]!.end)).toBe('Use the ');
    expect((units[1] as any).seg).toEqual({ kind: 'rich', text: '`<h1>` tag.' });
  });

  it('final mode resolves an unclosed fence as code', () => {
    expect(streamUnits('x\n```\ncode', true).map((u) => u.kind)).toEqual(['md', 'block']);
  });
});

describe('helpers', () => {
  it('streamArgsText reads markdown_text or markdown_text chunks', () => {
    expect(streamArgsText({ markdown_text: 'a' })).toBe('a');
    expect(streamArgsText({ chunks: [{ type: 'markdown_text', text: 'a' }, { type: 'blocks' }, { type: 'markdown_text', text: 'b' }] })).toBe('ab');
  });

  it('blocksText turns reply blocks back into readable text', () => {
    const text = 'Hi\n```html\n<h1>x</h1>\n```\nUse `<h1>` here';
    expect(blocksText(replyBlocks(text))).toBe('Hi\n\n```html\n<h1>x</h1>\n```\n\nUse `<h1>` here');
    expect(blocksText([{ type: 'context' }])).toBeUndefined();
  });
});
