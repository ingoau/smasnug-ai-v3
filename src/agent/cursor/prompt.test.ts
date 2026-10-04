import { describe, expect, it } from 'vitest';
import { composeCursorFollowUp, composeCursorPrompt } from './prompt.js';

const ctx = { repoUrl: 'https://github.com/ingoau/smasnug-ai-v3', ref: 'main' };

describe('Cursor prompt preamble', () => {
  const p = composeCursorPrompt('Make reminders accept "tmrw".', ctx);

  it('wraps the task after the fixed rules', () => {
    expect(p).toContain('https://github.com/ingoau/smasnug-ai-v3');
    expect(p.indexOf('Rules')).toBeLessThan(p.indexOf('<task>'));
    expect(p).toContain('<task>\nMake reminders accept "tmrw".\n</task>');
  });

  it('says to follow CLAUDE.md', () => {
    expect(p).toMatch(/Read CLAUDE\.md first and follow it/);
  });

  it('forbids touching .github/workflows/ and CI config, and says GitHub enforces it', () => {
    expect(p).toMatch(/NEVER create, modify, rename or delete anything under `\.github\/workflows\/`/);
    expect(p).toMatch(/other CI configuration/);
    expect(p).toMatch(/enforced at the GitHub level/);
  });

  it('asks for a focused change with typecheck and tests', () => {
    expect(p).toMatch(/Keep the change focused/);
    expect(p).toContain('`pnpm typecheck`');
    expect(p).toContain('`pnpm test`');
  });

  it('requires a subagent self-review, fixing its findings and re-running the checks before finishing', () => {
    const review = p.split('\n').find((l) => l.includes('Self-review'))!;
    expect(review).toMatch(/spin up a subagent to review your diff/);
    expect(review).toMatch(/correctness bugs/);
    expect(review).toMatch(/CLAUDE\.md conventions/);
    expect(review).toMatch(/tests/);
    expect(review).toMatch(/Fix every real issue/);
    expect(review).toMatch(/re-run `pnpm typecheck` and `pnpm test`/);
    expect(review).toMatch(/Only then finish/);
  });

  it('PR only: never push to the base branch or merge', () => {
    expect(p).toMatch(/pull request against `main` is opened automatically/);
    expect(p).toMatch(/Never push to `main`/);
    expect(p).toMatch(/never merge/);
  });

  it('follow-ups restate the rules (workflows, review, checks, same branch)', () => {
    const f = composeCursorFollowUp(['also handle "tmw"', 'and add a test'], ctx);
    expect(f).toMatch(/never touch `\.github\/workflows\/`/);
    expect(f).toMatch(/subagent review your changes/);
    expect(f).toContain('`pnpm typecheck`');
    expect(f).toMatch(/same branch/);
    expect(f).toContain('<follow_up>\nalso handle "tmw"\n</follow_up>');
    expect(f).toContain('<follow_up>\nand add a test\n</follow_up>');
  });
});
