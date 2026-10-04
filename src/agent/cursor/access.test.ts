/** Admin-only enforcement for coding agents (pure parts; the DB paths are in cursor.int.test.ts). */
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEYS = ['CURSOR_API_KEY', 'CURSOR_REPO', 'ADMIN_USER_ID', 'CURSOR_REF'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function load(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  process.env.OPENROUTER_KEY ||= 'test';
  vi.resetModules();
  return import('./agents.js');
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

const configured = { CURSOR_API_KEY: 'crsr_x', CURSOR_REPO: 'https://github.com/ingoau/smasnug-ai-v3', ADMIN_USER_ID: 'UADMIN' };

describe('coding agent access', () => {
  it('allows only the admin when configured', async () => {
    const m = await load(configured);
    expect(m.cursorRefusal('UADMIN')).toBeNull();
    expect(m.cursorRefusal('USOMEONE')).toMatch(/Only the bot's admin/);
    expect(m.cursorConfig()).toEqual({ repoUrl: 'https://github.com/ingoau/smasnug-ai-v3', ref: 'main', model: null });
  });

  it('refuses everyone (incl. the admin) when the key or repo is missing or invalid', async () => {
    for (const env of [
      { ...configured, CURSOR_API_KEY: '' },
      { ...configured, CURSOR_REPO: '' },
      { ...configured, CURSOR_REPO: 'not a url' },
      { ...configured, CURSOR_REPO: 'http://github.com/o/r' },
    ]) {
      const m = await load(env);
      expect(m.cursorRefusal('UADMIN')).toMatch(/aren't set up/);
    }
  });

  it('refuses everyone when no admin is configured', async () => {
    const m = await load({ CURSOR_API_KEY: 'k', CURSOR_REPO: 'https://github.com/o/r' });
    expect(m.isCursorAdmin(undefined)).toBe(false);
    expect(m.cursorRefusal('')).toMatch(/Only the bot's admin/);
    expect(m.cursorRefusal('UADMIN')).toMatch(/Only the bot's admin/);
  });

  it('spawnCodingAgent refuses non-admins before touching anything', async () => {
    const m = await load(configured);
    await expect(m.spawnCodingAgent({ threadId: 'C1:1.1', turnId: 1, ownerId: 'UOTHER', title: 't', instructions: 'i' })).rejects.toThrow(/Only the bot's admin/);
  });
});
