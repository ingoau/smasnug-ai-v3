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

  it('says to follow CLAUDE.md and allows search/exploration on the same agent', () => {
    expect(p).toMatch(/Read CLAUDE\.md first and follow it/);
    expect(p).toMatch(/codebase search\/exploration/i);
    expect(p).toMatch(/no separate search agent/);
  });

  it('forbids touching .github/workflows/ and CI config, and says GitHub enforces it', () => {
    expect(p).toMatch(/NEVER create, modify, rename or delete anything under `\.github\/workflows\/`/);
    expect(p).toMatch(/other CI or repository-policy configuration: nothing under `\.github\/` \(workflows, actions, CODEOWNERS, dependabot…\) or other CI\/CD config \(`\.gitlab-ci\.yml`/);
    expect(p).toMatch(/enforced at the GitHub level/);
  });

  it('asks for a focused change and leaves typecheck/tests to the agent\'s judgment', () => {
    expect(p).toMatch(/Keep any code change focused/);
    expect(p).toContain('`pnpm typecheck`');
    expect(p).toContain('`pnpm test`');
    expect(p).toMatch(/only when you judge them necessary/);
    expect(p).toMatch(/README\/docs-only/);
  });

  it('requires a subagent self-review only when useful, not always', () => {
    const review = p.split('\n').find((l) => l.includes('Self-review'))!;
    expect(review).toMatch(/Self-review only when useful/);
    expect(review).toMatch(/spin up a subagent to review your diff/);
    expect(review).toMatch(/correctness bugs/);
    expect(review).toMatch(/CLAUDE\.md convention/);
    expect(review).toMatch(/Skip the review subagent/);
    expect(review).toMatch(/exploration/);
    expect(review).toMatch(/docs\/README-only/);
    expect(review).toMatch(/does not affect runtime behaviour/);
  });

  it('PR only: never push to the base branch or merge; search-only may change nothing', () => {
    expect(p).toMatch(/pull request against `main` is opened automatically/);
    expect(p).toMatch(/search-only/);
    expect(p).toMatch(/Never push to `main`/);
    expect(p).toMatch(/never merge/);
  });

  it('follow-ups restate the rules (workflows, judgment-based review/checks, same branch)', () => {
    const f = composeCursorFollowUp(['also handle "tmw"', 'and add a test'], ctx);
    expect(f).toMatch(/never touch `\.github\/workflows\/`/);
    expect(f).toContain('CODEOWNERS');
    expect(f).toContain('`.circleci/`');
    expect(f).toMatch(/review subagent only when you judge them necessary/);
    expect(f).toContain('`pnpm typecheck`');
    expect(f).toMatch(/same branch/);
    expect(f).toContain('<follow_up>\nalso handle "tmw"\n</follow_up>');
    expect(f).toContain('<follow_up>\nand add a test\n</follow_up>');
  });
});
