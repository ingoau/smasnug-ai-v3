/**
 * json / jsonb parameters with lone UTF-16 surrogates (text cut in the middle of an emoji): Postgres rejects the
 * `\udXXX` escape JSON.stringify writes for them (22P02), which once failed a subagent run's final write.
 */
import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from './index.js';
import { wellFormedJson } from './json.js';

const HIGH = '\ud83c'; // first half of 🎮
const LOW = '\udfae';

afterAll(async () => {
  await sql.end();
});

describe('wellFormedJson', () => {
  it('replaces lone surrogates with U+FFFD and leaves everything else as JSON.stringify writes it', () => {
    const out = wellFormedJson({ a: `cut ${HIGH}`, b: `${LOW} x`, c: '🎮 ok' });
    expect(out).not.toMatch(/\\ud[89a-f]/);
    expect(JSON.parse(out)).toEqual({ a: 'cut �', b: '� x', c: '🎮 ok' });
    // A literal backslash-u text is not an escape of a surrogate: kept.
    expect(wellFormedJson({ s: '\\ud83c' })).toBe(JSON.stringify({ s: '\\ud83c' }));
    expect(JSON.parse(wellFormedJson({ s: `\\${HIGH}` }))).toEqual({ s: '\\�' });
    expect(wellFormedJson(undefined)).toBeUndefined();
    expect(wellFormedJson([1, 'x'])).toBe('[1,"x"]');
  });
});

describe('the db client', () => {
  it('stores json with a lone surrogate instead of failing the statement', async () => {
    const [row] = await sql<{ v: any }[]>`select ${sql.json({ text: `Run a game jam ${HIGH}…`, ok: '🎮' })}::jsonb as v`;
    expect(row!.v).toEqual({ text: 'Run a game jam �…', ok: '🎮' });
  });
});
