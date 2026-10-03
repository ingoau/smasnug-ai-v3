import { describe, expect, it } from 'vitest';
import { extractPartialString } from './partial-json.js';

describe('extractPartialString', () => {
  it('returns nothing before the field value starts', () => {
    expect(extractPartialString('', 'text')).toBeUndefined();
    expect(extractPartialString('{', 'text')).toBeUndefined();
    expect(extractPartialString('{"te', 'text')).toBeUndefined();
    expect(extractPartialString('{"text"', 'text')).toBeUndefined();
    expect(extractPartialString('{"text":', 'text')).toBeUndefined();
  });

  it('extracts a growing string value', () => {
    expect(extractPartialString('{"text":"', 'text')).toEqual({ value: '', complete: false });
    expect(extractPartialString('{"text":"Hello wor', 'text')).toEqual({ value: 'Hello wor', complete: false });
    expect(extractPartialString('{"text":"Hello world"', 'text')).toEqual({ value: 'Hello world', complete: true });
    expect(extractPartialString('{"text":"Hello world"}', 'text')).toEqual({ value: 'Hello world', complete: true });
  });

  it('decodes escapes and holds back incomplete ones', () => {
    expect(extractPartialString('{"text":"a\\', 'text')?.value).toBe('a');
    expect(extractPartialString('{"text":"a\\n', 'text')?.value).toBe('a\n');
    expect(extractPartialString('{"text":"say \\"hi\\"', 'text')?.value).toBe('say "hi"');
    expect(extractPartialString('{"text":"x\\u00', 'text')?.value).toBe('x');
    expect(extractPartialString('{"text":"x\\u00e9y', 'text')?.value).toBe('xéy');
    expect(extractPartialString('{"text":"back\\\\slash', 'text')?.value).toBe('back\\slash');
  });

  it('handles surrogate pairs split across chunks', () => {
    const full = JSON.stringify({ text: 'hi 😀!' }).replace('😀', '\\ud83d\\ude00');
    for (let i = 0; i <= full.length; i++) {
      const v = extractPartialString(full.slice(0, i), 'text')?.value ?? '';
      expect('hi 😀!'.startsWith(v)).toBe(true);
    }
    expect(extractPartialString(full, 'text')?.value).toBe('hi 😀!');
  });

  it('skips other fields in any order, including nested values', () => {
    const json = '{"files":[{"filename":"a.md","content":"x \\" } ] {"}],"n":12,"ok":true,"text":"after files';
    expect(extractPartialString(json, 'text')).toEqual({ value: 'after files', complete: false });
    expect(extractPartialString('{"files":[{"filename":"a.md"', 'text')).toBeUndefined();
    expect(extractPartialString('{"other":"text"}', 'text')).toBeUndefined();
  });

  it('every prefix of a real stream yields a prefix of the final text', () => {
    const text = 'Line one,\n"quoted" \\ tab\t and unicode ü — done.';
    const full = JSON.stringify({ text, files: [] });
    let last = '';
    for (let i = 0; i <= full.length; i++) {
      const v = extractPartialString(full.slice(0, i), 'text')?.value ?? '';
      expect(text.startsWith(v)).toBe(true);
      expect(v.length).toBeGreaterThanOrEqual(last.length);
      last = v;
    }
    expect(last).toBe(text);
  });
});
