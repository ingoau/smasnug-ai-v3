import { describe, expect, it } from 'vitest';
import { frontSystemPrompt } from './front.js';

describe('frontSystemPrompt About you', () => {
  const p = frontSystemPrompt('smasnug ai');

  it('includes maintainer-described model and harness self-awareness', () => {
    expect(p).toContain('# About you');
    expect(p).toMatch(/GPT-6 Luna/);
    expect(p).toMatch(/API access at API rates/);
    expect(p).toMatch(/custom Slack harness/);
    expect(p).toMatch(/what you've been told/i);
  });

  it('lists real harness capabilities without inventing infra', () => {
    expect(p).toMatch(/search Slack/);
    expect(p).toMatch(/the web/);
    expect(p).toMatch(/fetch pages/);
    expect(p).toMatch(/read threads, channels, images, uploaded files and canvases/);
    expect(p).toMatch(/create and edit canvases/);
    expect(p).toMatch(/reminders and change-watches/);
    expect(p).toMatch(/remember durable facts/);
    expect(p).toMatch(/send messages elsewhere/);
    expect(p).toMatch(/background subagents/);
    expect(p).toMatch(/In DMs you can title/);
    expect(p).not.toMatch(/OpenRouter|Hack Club AI|Postgres|Redis|BullMQ|Socket Mode/i);
    expect(p).toMatch(/don't claim Codex/);
    expect(p).not.toContain('spawn_coding_agent');
  });

  it('does not claim it can hot-patch itself live', () => {
    expect(p).toMatch(/Don't claim you can hot-patch/);
    expect(p).toMatch(/Behaviour changes are shipped by the maintainer/);
  });
});

describe('CODING_AGENTS_PROMPT', () => {
  it('says plainly that the current speaker is the bot admin and may launch coding agents', async () => {
    const { CODING_AGENTS_PROMPT } = await import('./front.js');
    expect(CODING_AGENTS_PROMPT).toMatch(/current speaker IS the bot admin/);
    expect(CODING_AGENTS_PROMPT).toMatch(/may launch coding agents/);
    expect(CODING_AGENTS_PROMPT).toMatch(/Never tell them coding agents are admin-only/);
  });

  it('proposes a coding agent only for an actual request, not for musings', async () => {
    const { CODING_AGENTS_PROMPT } = await import('./front.js');
    expect(CODING_AGENTS_PROMPT).toMatch(/only when the admin asks for a change or investigation/);
    expect(CODING_AGENTS_PROMPT).toMatch(/musings and feedback/);
  });
});

describe('frontSystemPrompt delegation and scope rules', () => {
  const p = frontSystemPrompt('smasnug ai');

  it('fans named independent items out, also for comparisons; dependent steps stay one task / a later round', () => {
    expect(p).toMatch(/Independent parts \([^)]*frameworks[^)]*also when the ask is to compare them\) get one task each in ONE spawn_subagent call/);
    expect(p).toMatch(/need each other's results are one task or a later round/);
  });

  it('"one speaker" is about identity and permissions, not about whose request the work serves', () => {
    expect(p).toMatch(/identity and permissions are theirs/);
    expect(p).toMatch(/work someone else requested/);
    expect(p).not.toMatch(/act only for them/);
  });

  it('a correction to just-done or proposed work is a go-ahead; no "I\'ll …" without the call', () => {
    expect(p).toMatch(/a correction \("wait, I meant X"\) to something you just did or proposed, means act now/);
    expect(p).toMatch(/"I'll update…"\) goes in the same step as the call that does the work/);
  });

  it('single-file deliverables are written with create_file', () => {
    expect(p).toMatch(/write the file yourself with create_file/);
  });
});
