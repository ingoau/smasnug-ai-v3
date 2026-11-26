/** Theo mode setting against the test database. */
import '../tools/test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../db/index.js';
import { setTheoMode, THEO_MODE_KEY, theoModeEnabled } from './theo-mode.js';

describe('theo mode setting', () => {
  afterAll(() => setTheoMode(false));

  it('is off by default and round-trips through the settings table', async () => {
    await setTheoMode(false);
    expect(await theoModeEnabled()).toBe(false);
    await setTheoMode(true);
    expect(await theoModeEnabled()).toBe(true);
    const [row] = await sql<{ value: unknown }[]>`select value from settings where key = ${THEO_MODE_KEY}`;
    expect(row?.value).toBe(true);
    await setTheoMode(false);
    expect(await theoModeEnabled()).toBe(false);
  });
});
