import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { RunLabel, slackWaitLabel, THINKING_DETAILS, WRITING_DETAILS } from './child.js';

describe('RunLabel (the subagent card label as a step streams)', () => {
  it('a tool label only while the tool runs; "Thinking…" once the last call of the step returned', () => {
    const l = new RunLabel();
    l.stepStart();
    expect(l.toolCall('a', 'Searching the web for “x”')).toBe('Searching the web for “x”');
    expect(l.toolCall('b', 'Reading example.com')).toBe('Reading example.com');
    expect(l.toolDone('a')).toBeNull(); // b still runs
    expect(l.toolDone('b')).toBe(THINKING_DETAILS);
    expect(l.toolDone('b')).toBeNull(); // unknown / repeated
  });

  it('"Writing up…" once the model streams answer text in a step without tool calls (not for a short preamble)', () => {
    const l = new RunLabel();
    l.stepStart();
    expect(l.text('Let me check.')).toBeNull();
    expect(l.text('The Pico 2 W costs $7 at most resellers, and the Pico W…')).toBe(WRITING_DETAILS);
    expect(l.text('The Pico 2 W costs $7 at most resellers, and the Pico W is $6.')).toBeNull(); // once
    l.stepStart();
    l.toolCall('c', 'Searching Slack');
    expect(l.text('Some text the model wrote next to its tool call, long enough.')).toBeNull();
  });

  it('wait labels name the search limit only for search.messages', () => {
    expect(slackWaitLabel(4200)).toBe("Waiting for Slack's search rate limit (5s)");
    expect(slackWaitLabel(1000, 'conversations.info')).toBe("Waiting for Slack's rate limit (1s)");
  });
});
