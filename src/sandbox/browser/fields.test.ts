import { describe, expect, it } from 'vitest';
import { fieldProbe, fieldRefusal, parseField } from './fields.js';

describe('fieldProbe / parseField / fieldRefusal', () => {
  it('focuses the ref and evaluates without touching stdin', () => {
    const b = fieldProbe('@e4');
    expect(b).toMatch(/^timeout 10 agent-browser focus '@e4' <\/dev\/null/);
    expect(b).toContain(`agent-browser eval -b '`);
    expect(b.match(/<\/dev\/null/g)).toHaveLength(2);
    const js = Buffer.from(/eval -b '([^']+)'/.exec(b)![1]!, 'base64').toString('utf8');
    expect(js).toContain('document.activeElement');
    expect(js).not.toContain('contentDocument');
  });
  it('parses what has focus', () => {
    expect(parseField('ABFIELD INPUT password Your%20password')).toEqual({ tag: 'INPUT', type: 'password', label: 'Your password' });
    expect(parseField('noise\nABFIELD INPUT email ')).toEqual({ tag: 'INPUT', type: 'email', label: '' });
    expect(parseField('ABFIELD IFRAME - ')).toMatchObject({ tag: 'IFRAME' });
    expect(parseField('')).toBeNull();
  });
  it('refuses a field inside a frame, a non-input and the wrong type', () => {
    expect(fieldRefusal(parseField('ABFIELD IFRAME - '), 'password', '@e9')).toMatch(/embedded frame/);
    expect(fieldRefusal(parseField('ABFIELD DIV - '), 'username', '@e2')).toMatch(/isn't an input/);
    expect(fieldRefusal(parseField('ABFIELD INPUT text Email'), 'password', '@e3')).toMatch(/isn't a password field/);
    expect(fieldRefusal(parseField('ABFIELD INPUT password P'), 'username', '@e4')).toMatch(/not a username field/);
    expect(fieldRefusal(null, 'password', '@e4')).toMatch(/Couldn't check/);
    expect(fieldRefusal(parseField('ABFIELD INPUT password P'), 'password', '@e4')).toBeNull();
    expect(fieldRefusal(parseField('ABFIELD INPUT email E'), 'username', '@e3')).toBeNull();
    expect(fieldRefusal(parseField('ABFIELD INPUT tel C'), 'totp', '@e5')).toBeNull();
  });
});
