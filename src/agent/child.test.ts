import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { RunLabel, SlackWaitTracker, slackWaitLabel, THINKING_DETAILS, WRITING_DETAILS } from './child.js';

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

  it('wait labels say plainly that Slack is the hold-up', () => {
    expect(slackWaitLabel(4200)).toBe('Waiting on Slack (5s)');
    expect(slackWaitLabel(0)).toBe('Waiting on Slack (1s)');
  });
});

describe('SlackWaitTracker (the card label while Slack calls wait)', () => {
  it('counts down to the expected end, then restores the label from before', () => {
    const w = new SlackWaitTracker();
    expect(w.label(0)).toBeNull();
    expect(w.start({ method: 'search.messages', estimateMs: 29_500 }, 'Searching Slack for “x”', 0)).toBe("Waiting on Slack (30s)");
    expect(w.waiting).toBe(true);
    expect(w.label(10_000)).toBe("Waiting on Slack (20s)");
    expect(w.label(29_800)).toBe("Waiting on Slack (1s)"); // overdue: never 0 or negative
    expect(w.end()).toBe('Searching Slack for “x”');
    expect(w.waiting).toBe(false);
    expect(w.end()).toBeNull(); // unmatched end
  });

  it('parallel waits: one label until the last ends; tool labels arriving meanwhile are kept, not shown', () => {
    const w = new SlackWaitTracker();
    w.start({ method: 'conversations.info', estimateMs: 5000 }, 'Thinking…', 0);
    expect(w.label(0)).toBe("Waiting on Slack (5s)");
    // A search waits longer: the label counts down to the later end.
    expect(w.start({ method: 'search.messages', estimateMs: 30_000 }, 'ignored', 1000)).toBe("Waiting on Slack (30s)");
    expect(w.defer('Searching Slack for “y”')).toBe(true);
    expect(w.end()).toBeNull();
    expect(w.label(16_000)).toBe("Waiting on Slack (15s)");
    expect(w.end()).toBe('Searching Slack for “y”');
    expect(w.defer('Thinking…')).toBe(false); // nothing waits: shown right away
  });
});
