import { tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerTool, STOPPED_TOOL_RESULT, toolsFor } from './tools.js';

const ran: string[] = [];
registerTool({
  name: 'test_side_effect',
  roles: ['child'],
  build: (ctx) =>
    tool({
      description: 'x',
      inputSchema: z.object({ v: z.string() }),
      execute: async ({ v }) => {
        ran.push(`${ctx.threadId}:${v}`);
        return `done ${v}`;
      },
    }),
});

const ctx = (abortSignal?: AbortSignal) => ({ threadId: 'C1:1.0', channelId: 'C1', threadTs: '1.0', speakerId: 'U1', abortSignal, extras: {} });
const exec = (t: any, v: string, signal?: AbortSignal) => t.execute({ v }, { toolCallId: 'tc', messages: [], abortSignal: signal });

describe('toolsFor: the stop signal', () => {
  it('runs normally while not aborted', async () => {
    const c = new AbortController();
    expect(await exec(toolsFor('child', ctx(c.signal)).test_side_effect, 'a')).toBe('done a');
    expect(ran).toContain('C1:1.0:a');
  });

  it('never starts a tool once the turn / run signal (or the call signal) is aborted', async () => {
    const c = new AbortController();
    const tools = toolsFor('child', ctx(c.signal));
    c.abort();
    expect(await exec(tools.test_side_effect, 'b')).toBe(STOPPED_TOOL_RESULT);
    const call = new AbortController();
    call.abort();
    expect(await exec(toolsFor('child', ctx()).test_side_effect, 'c', call.signal)).toBe(STOPPED_TOOL_RESULT);
    expect(ran).not.toContain('C1:1.0:b');
    expect(ran).not.toContain('C1:1.0:c');
  });
});
