import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../db/index.js', () => ({ sql: {} }));

const { inlineToMrkdwn, policyBlocks, privacyPolicy } = await import('./privacy.js');

describe('inlineToMrkdwn', () => {
  it('converts bold, italics, links and code; escapes &<>', () => {
    expect(inlineToMrkdwn('**bold** and *it* and __b2__')).toBe('*bold* and _it_ and *b2*');
    expect(inlineToMrkdwn('see [Exa](https://exa.ai) & <x>')).toBe('see <https://exa.ai|Exa> &amp; &lt;x&gt;');
    expect(inlineToMrkdwn('messages starting with `##` and `**x**`')).toBe('messages starting with `##` and `**x**`');
  });
});

describe('policyBlocks', () => {
  it('turns # / ## into header blocks, ### into a bold line starting a section, lists into bullets', () => {
    const blocks = policyBlocks('# Title\n\nIntro **x**.\n\n## Part\n\n- one\n- two\n\n### Sub\ntext') as any[];
    expect(blocks.map((b) => b.type)).toEqual(['header', 'section', 'header', 'section', 'section']);
    expect(blocks[0].text.text).toBe('Title');
    expect(blocks[1].text.text).toBe('Intro *x*.');
    expect(blocks[3].text.text).toBe('• one\n• two');
    expect(blocks[4].text.text).toBe('*Sub*\ntext');
  });

  it('splits long sections at line breaks under Slack\'s limit', () => {
    const md = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const blocks = policyBlocks(md) as any[];
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    expect(blocks.map((b) => b.text.text).join('\n')).toBe(md);
  });

  it('renders the real PRIVACY.md within modal limits', () => {
    const { text, version } = privacyPolicy();
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    const blocks = policyBlocks(text) as any[];
    expect(blocks.length).toBeGreaterThan(3);
    expect(blocks.length).toBeLessThanOrEqual(100);
  });
});
