import { describe, expect, it } from 'vitest';
import { ab, firstUrl, normRef, pageOf, pageScript, parseSections, shortError, STDIN_VALUE, trimSnapshot, validKey } from './cli.js';

describe('normRef', () => {
  it('accepts the usual spellings', () => {
    expect(normRef('@e12')).toBe('@e12');
    expect(normRef('e3')).toBe('@e3');
    expect(normRef(' [ref=e7] ')).toBe('@e7');
    expect(normRef('ref=E5')).toBe('@e5');
  });
  it('refuses selectors and junk', () => {
    for (const bad of ['#login', 'button', '@e', 'e1; rm -rf /', '@e1 @e2', '', 'e1234567']) expect(normRef(bad)).toBeNull();
  });
});

describe('validKey', () => {
  it('accepts key names and combinations', () => {
    for (const k of ['Enter', 'Tab', 'Escape', 'ArrowDown', 'Control+a', 'Shift+Tab', 'Control+Shift+K', 'a', '/', 'F5', 'PageDown']) expect(validKey(k)).toBe(true);
  });
  it('refuses text', () => {
    for (const k of ['hello world', 'Control+', '$(id)', 'Enter; ls', '', 'abcdefghijklmnopqrstuvwxyz']) expect(validKey(k)).toBe(false);
  });
});

describe('ab (command quoting)', () => {
  it('quotes every argument', () => {
    expect(ab('fill', '@e1', '--', "it's $(rm -rf /) `x`")).toBe(`agent-browser 'fill' '@e1' '--' 'it'\\''s $(rm -rf /) \`x\`'`);
  });
  it('turns the stdin placeholder into the variable, unquoted by shq', () => {
    expect(ab('fill', '@e4', '--', STDIN_VALUE)).toBe(`agent-browser 'fill' '@e4' '--' "$SBX_VALUE"`);
  });
});

describe('pageScript / parseSections', () => {
  it('builds action, settle, look and snapshot sections', () => {
    const s = pageScript({ actions: [['click', '@e3']], settle: true, snapshot: 'interactive' });
    expect(s).toContain(`{ agent-browser 'click' '@e3'; } 2>&1; printf '\\n@@ab:rc=%s@@\\n' "$?"`);
    expect(s).toContain(`agent-browser 'wait' '--load' 'domcontentloaded'`);
    expect(s).toContain(`agent-browser 'get' 'url'`);
    expect(s).toContain(`agent-browser 'snapshot' '-i' '-c'`);
    expect(s.trim().endsWith(`printf '\\n@@ab:end@@\\n'`)).toBe(true);
  });
  it('chains several actions and stops at the first failure', () => {
    expect(pageScript({ actions: [['focus', '@e1'], ['press', 'Enter']] })).toContain(`{ agent-browser 'focus' '@e1' && agent-browser 'press' 'Enter'; }`);
  });
  it('close does not look at the page (that would relaunch the browser)', () => {
    const s = pageScript({ actions: [['close']], look: false });
    expect(s).not.toContain('get');
  });
  it('full snapshots keep text and take a scope', () => {
    expect(pageScript({ snapshot: 'all', snapshotArgs: ['-s', '#main'] })).toContain(`agent-browser 'snapshot' '-c' '-s' '#main'`);
  });
  it('parses the sections back', () => {
    const out = '\n@@ab:action@@\n✗ covered by <div#consent>\n@@ab:rc=1@@\n\n@@ab:url@@\nhttps://example.com/a?b=1\n\n@@ab:title@@\nExample\n\n@@ab:snapshot@@\n- button "OK" [ref=e1]\n\n@@ab:end@@\n';
    const s = parseSections(out);
    expect(s).toMatchObject({ action: '✗ covered by <div#consent>', rc: 1, url: 'https://example.com/a?b=1', title: 'Example', snapshot: '- button "OK" [ref=e1]', complete: true });
  });
  it('keeps what a guard printed and notices an incomplete run', () => {
    const s = parseSections('PASSWORD_FIELD\n');
    expect(s.pre).toBe('PASSWORD_FIELD');
    expect(s.complete).toBe(false);
    const t = parseSections('\n@@ab:action@@\nworking');
    expect(t.action).toBe('working');
    expect(t.rc).toBeUndefined();
    expect(t.complete).toBe(false);
  });
});

describe('firstUrl', () => {
  it('takes the URL line and ignores noise', () => {
    expect(firstUrl('⚠ something\nhttps://x.test/p\n')).toBe('https://x.test/p');
    expect(firstUrl('about:blank')).toBe('about:blank');
    expect(firstUrl('no url here')).toBeNull();
  });
});

describe('trimSnapshot', () => {
  it('drops blank lines, cuts long lines and stops at the budget on a line boundary', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- link "Item ${i}" [ref=e${i}]`);
    const t = trimSnapshot(['', ...lines, '', `- text "${'x'.repeat(500)}"`].join('\n'), 300);
    expect(t.text.split('\n').every((l) => l.trim())).toBe(true);
    expect(t.text.length).toBeLessThanOrEqual(300);
    expect(t.cut).toBe(51 - t.text.split('\n').length);
    const long = trimSnapshot(`- text "${'y'.repeat(500)}"`, 10_000, 100);
    expect(long.text.length).toBe(101);
    expect(long.cut).toBe(0);
  });
  it('always keeps at least one line', () => {
    expect(trimSnapshot('a'.repeat(50), 10, 240).text).toHaveLength(50);
  });
});

describe('pageOf / shortError', () => {
  it('pages text', () => {
    expect(pageOf('abcdef', 2, 3)).toEqual({ text: 'cde', from: 2, to: 5, total: 6, next: 5 });
    expect(pageOf('abcdef', 4, 3).next).toBeNull();
    expect(pageOf('abc', 10, 3)).toMatchObject({ text: '', from: 3, next: null });
  });
  it('cleans error output', () => {
    expect(shortError('\u001b[31m✗ Element not found\u001b[0m\n\n')).toBe('✗ Element not found');
    expect(shortError('')).toBe('no error message');
    expect(shortError('x'.repeat(700), 600)).toHaveLength(601);
  });
});
