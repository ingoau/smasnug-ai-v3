import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
// Registration only: no queries run (module-level sql`` fragments just need a callable).
vi.mock('../db/index.js', () => ({ sql: Object.assign(() => ({}), { json: (v: unknown) => v }) }));
vi.mock('../core/redis.js', () => ({ redis: {} }));

// Every module's tools, as the worker registers them.
await import('../tools/index.js');
await import('./register.js');
await import('../features/register.js');
const { registeredTools } = await import('../core/tools.js');
const { PRIVATE_ALLOWED_TOOLS, PRIVATE_HIDDEN_TOOLS, shareActions, PRIVATE_SHARE_ACTION } = await import('./private-reply.js');

describe('private (`!p`) turn tools', () => {
  it('classifies every front tool as allowed or hidden in a private turn', () => {
    // A new front tool must be placed in one of the lists (does it have an effect others can see?).
    const front = registeredTools().filter((t) => t.roles.includes('front')).map((t) => t.name);
    const unclassified = front.filter((n) => !PRIVATE_ALLOWED_TOOLS.has(n) && !PRIVATE_HIDDEN_TOOLS.has(n));
    expect(unclassified).toEqual([]);
    expect([...PRIVATE_ALLOWED_TOOLS].filter((n) => PRIVATE_HIDDEN_TOOLS.has(n))).toEqual([]);
  });

  it('hides the tools with public effects', () => {
    for (const n of ['react', 'send_message', 'leave_thread', 'set_reminder', 'open_code_channel']) expect(PRIVATE_HIDDEN_TOOLS.has(n)).toBe(true);
    for (const n of ['reply', 'spawn_subagent', 'create_canvas', 'edit_canvas', 'create_file']) expect(PRIVATE_ALLOWED_TOOLS.has(n)).toBe(true);
  });
});

describe('shareActions', () => {
  it('is one "Send to thread" button carrying the reply id', () => {
    const b = shareActions(42) as any;
    expect(b.type).toBe('actions');
    expect(b.elements).toEqual([expect.objectContaining({ action_id: PRIVATE_SHARE_ACTION, value: '42', text: { type: 'plain_text', text: 'Send to thread' } })]);
  });
});
