import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.LOG_LEVEL = 'silent';
});

import type { ModelMessage } from 'ai';
import { REDACTED, redactToolInput } from './tool-redact.js';
import { TraceRecorder } from './trace.js';
import { compactHistory } from './util.js';

const SECRET = 'sk_live_supersecret_123';
const call = { name: 'k', type: 'login', username: 'me@x.com', password: SECRET, totp: 'JBSWY3DPEHPK3PXP', value: SECRET };

describe('secret tool inputs', () => {
  it('redacts save_credential secrets, keeps the rest', () => {
    const out = redactToolInput('save_credential', call) as Record<string, unknown>;
    expect(out).toMatchObject({ name: 'k', type: 'login', username: 'me@x.com', password: REDACTED, totp: REDACTED, value: REDACTED });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(call.password).toBe(SECRET); // not mutated
  });

  it('redacts a non-object input of a secret-taking tool whole, leaves other tools alone', () => {
    expect(redactToolInput('save_credential', `{"value":"${SECRET}"`)).toBe(REDACTED);
    expect(redactToolInput('fetch_url', { url: SECRET })).toEqual({ url: SECRET });
  });

  it('turn_tools summary (next turn <previous_turn_tools>) never holds the secret', async () => {
    const { summarizeToolCalls } = await import('./front.js');
    const out = summarizeToolCalls([{ tool: 'save_credential', args: call }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.args).not.toContain(SECRET);
    expect(out[0]!.args).toContain(REDACTED);
  });

  it('traces never hold the secret', () => {
    const r = new TraceRecorder();
    r.ingest({ type: 'start-step' });
    r.ingest({ type: 'tool-call', toolCallId: 'c1', toolName: 'save_credential', input: call });
    r.ingest({ type: 'tool-result', toolCallId: 'c1', toolName: 'save_credential', output: 'Saved "k".' });
    r.ingest({ type: 'finish-step', finishReason: 'tool-calls', usage: {} });
    const steps = r.finish();
    expect(JSON.stringify(steps)).not.toContain(SECRET);
    expect(steps[0]!.calls[0]!.input).toMatchObject({ username: 'me@x.com', password: REDACTED });
  });

  it("a subagent's stored history never holds the secret", () => {
    const msgs: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'save_credential', input: call }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'save_credential', output: { type: 'text', value: 'Saved' } }] },
    ];
    const out = compactHistory(msgs);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(msgs)).toContain(SECRET); // the live conversation is untouched
  });
});
