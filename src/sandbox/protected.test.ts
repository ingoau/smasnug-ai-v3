import { describe, expect, it } from 'vitest';
import { PROTECTED_MARKER, protectedCheckBash, protectedDir, protectedRefusal } from './protected.js';

describe('protectedDir', () => {
  it('matches the directories and what is inside them', () => {
    expect(protectedDir('/work/.vault')).toBe('/work/.vault');
    expect(protectedDir('/work/.vault/github')).toBe('/work/.vault');
    expect(protectedDir('/work/.agent-browser/sessions/default.json')).toBe('/work/.agent-browser');
    expect(protectedDir('/work/.last/stdout')).toBe('/work/.last');
    expect(protectedDir('/work/.lastly')).toBeNull();
    expect(protectedDir('/work/site/.vault/x')).toBeNull();
    expect(protectedDir('/work/.last/stdout', ['/work/.vault'])).toBeNull();
  });
  it('explains each one', () => {
    expect(protectedRefusal('/work/.agent-browser')).toMatch(/cookies/);
    expect(protectedRefusal('/work/.last')).toMatch(/raw command output/);
  });
});

describe('protectedCheckBash', () => {
  it('resolves links and checks hard links in the sandbox', () => {
    const b = protectedCheckBash(`'/work/out.txt'`);
    expect(b).toContain(`realpath -m -- '/work/out.txt'`);
    expect(b).toContain(`'/work/.vault'|'/work/.vault'/*|'/work/.agent-browser'|'/work/.agent-browser'/*|'/work/.last'|'/work/.last'/*`);
    expect(b).toContain('-samefile');
    expect(b).toContain(`echo ${PROTECTED_MARKER}; exit 3`);
  });
});
