/**
 * LIVE=1 + CURSOR_API_KEY: read-only calls against the real Cursor Cloud Agents API (never launches an agent).
 *   LIVE=1 pnpm vitest run src/agent/cursor/cursor.live.test.ts
 */
import { describe, expect, it } from 'vitest';

const LIVE = process.env.LIVE === '1';
if (LIVE) {
  try {
    process.loadEnvFile('.env');
  } catch {}
  process.env.OPENROUTER_KEY ||= 'test';
}

describe.skipIf(!LIVE || !process.env.CURSOR_API_KEY)('Cursor API (LIVE, read-only)', () => {
  it('authenticates (GET /v1/me) and lists agents (GET /v1/agents)', async () => {
    const { createCursorClient } = await import('./api.js');
    const c = createCursorClient({ apiKey: process.env.CURSOR_API_KEY!, baseUrl: process.env.CURSOR_API_URL || undefined });
    const me = await c.me();
    expect(typeof me.apiKeyName).toBe('string');
    const list = await c.listAgents(1);
    expect(Array.isArray(list.items)).toBe(true);
    for (const a of list.items) expect(a.id).toMatch(/^bc[-_]/);
  });

  it('maps an unknown agent to a CursorApiError (no side effects)', async () => {
    const { createCursorClient, CursorApiError } = await import('./api.js');
    const c = createCursorClient({ apiKey: process.env.CURSOR_API_KEY!, baseUrl: process.env.CURSOR_API_URL || undefined });
    const err = await c.getAgent('bc-00000000-0000-0000-0000-000000000000').catch((e) => e);
    expect(err).toBeInstanceOf(CursorApiError);
    expect([400, 404]).toContain(err.status);
  });
});
