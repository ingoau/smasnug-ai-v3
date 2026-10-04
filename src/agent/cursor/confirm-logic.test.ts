import { describe, expect, it } from 'vitest';
import { CODING_AGENTS_PROMPT, frontSystemPrompt } from '../prompts/front.js';
import { chunkText, CODING_INSTRUCTIONS_MAX, decideLaunchClick, launchOutcomeFallback, launchOutcomeIsMention, launchPreviewBlocks, renderLaunchOutcome } from './confirm-logic.js';

const future = new Date(Date.now() + 60_000);

describe('decideLaunchClick', () => {
  const p = { ownerId: 'UADMIN', status: 'pending', expiresAt: future };
  it('only the admin who asked may launch a pending, unexpired proposal', () => {
    expect(decideLaunchClick(p, 'UADMIN', 'UADMIN')).toBe('ok');
    expect(decideLaunchClick(p, 'UOTHER', 'UADMIN')).toBe('wrong_user');
    expect(decideLaunchClick(p, 'UADMIN', undefined)).toBe('wrong_user');
    expect(decideLaunchClick({ ...p, ownerId: 'UX' }, 'UADMIN', 'UADMIN')).toBe('wrong_user');
    expect(decideLaunchClick(undefined, 'UADMIN', 'UADMIN')).toBe('not_found');
  });
  it('stale clicks', () => {
    expect(decideLaunchClick({ ...p, expiresAt: new Date(Date.now() - 1) }, 'UADMIN', 'UADMIN')).toBe('expired');
    for (const s of ['launched', 'launching', 'cancelled', 'failed'] as const) expect(decideLaunchClick({ ...p, status: s }, 'UADMIN', 'UADMIN')).toBe(s);
    expect(decideLaunchClick({ ...p, status: 'expired' }, 'UADMIN', 'UADMIN')).toBe('expired');
  });
});

describe('launch preview', () => {
  it('chunks long text within the section limit, losing nothing', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(i % 50)}`).join('\n');
    const chunks = chunkText(text);
    expect(chunks.every((c) => c.length <= 2900)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
    expect(chunkText('y'.repeat(7000)).join('')).toBe('y'.repeat(7000));
  });
  it('shows the task verbatim as plain_text and fits the block limit at the max length', () => {
    const blocks = launchPreviewBlocks({ pendingId: 'p', title: 'T', instructions: 'a'.repeat(CODING_INSTRUCTIONS_MAX), repoUrl: 'https://github.com/o/r', ref: 'main', ttlMin: 15 }) as any[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    const task = blocks.filter((b) => b.type === 'section' && b.text.type === 'plain_text' && !b.text.text.startsWith('Title:'));
    expect(task.map((b) => b.text.text).join('')).toBe('a'.repeat(CODING_INSTRUCTIONS_MAX));
    expect(blocks.at(-1).elements.map((e: any) => e.action_id)).toEqual(['coding:launch', 'coding:cancel']);
  });
  it('preview rules blurb: tests and self-review are judgment-based; PR when there are changes', () => {
    const blocks = launchPreviewBlocks({ pendingId: 'p', title: 'T', instructions: 'x', repoUrl: 'https://github.com/o/r', ref: 'main', ttlMin: 15 }) as any[];
    const intro = blocks.find((b) => b.type === 'section' && b.text?.type === 'mrkdwn')?.text?.text as string;
    expect(intro).toMatch(/pull request opens when there are changes/);
    const rules = blocks.find((b) => b.type === 'context' && String(b.elements?.[0]?.text ?? '').includes('fixed rules'))?.elements?.[0]?.text as string;
    expect(rules).toMatch(/tests and self-review when the agent judges them necessary/);
  });
});

// Review #12: the admin-only section isn't part of everyone's system prompt.
describe('front prompt', () => {
  it('keeps the coding-agent section out of the shared base prompt', () => {
    expect(frontSystemPrompt('Bot')).not.toContain('spawn_coding_agent');
    expect(CODING_AGENTS_PROMPT).toContain('spawn_coding_agent');
    expect(CODING_AGENTS_PROMPT).toContain('Launch');
  });
  it('allows explore/search and treats tests/review as judgment-based in the admin prompt', () => {
    expect(CODING_AGENTS_PROMPT).toMatch(/explore or search/);
    expect(CODING_AGENTS_PROMPT).toMatch(/tests and self-review when the agent judges them necessary/);
    expect(CODING_AGENTS_PROMPT).toMatch(/PR link if one is present|share findings/i);
    expect(CODING_AGENTS_PROMPT).toMatch(/mention testing only if checks ran/);
  });
});

describe('renderLaunchOutcome', () => {
  const r = (outcome: Parameters<typeof renderLaunchOutcome>[0]['outcome'], title = 'Fix "tmrw" <parsing>') =>
    renderLaunchOutcome({ pendingId: 'p1', ownerId: 'UADMIN', title, outcome });
  it('renders each outcome as a system notice', () => {
    expect(r({ kind: 'cancelled' })).toContain('<coding_agent_outcome id="p1" status="cancelled" title="Fix tmrw parsing"/>');
    expect(r({ kind: 'cancelled' })).toMatch(/^System notice \(not a message from <@UADMIN>\)/m);
    expect(r({ kind: 'cancelled' })).toContain('clicked Cancel');
    expect(r({ kind: 'failed', error: "Couldn't start the coding agent: <403>" })).toContain("could not start (Couldn't start the coding agent: 403)");
    expect(r({ kind: 'expired', ttlMin: 15 })).toContain('within 15 min');
    expect(r({ kind: 'expired', ttlMin: 15 })).toContain('stay silent');
    for (const o of [{ kind: 'cancelled' as const }, { kind: 'expired' as const, ttlMin: 1 }]) expect(r(o)).toContain("Don't propose it again unless they ask.");
  });
  it('fallback only for a failed launch', () => {
    expect(launchOutcomeFallback({ kind: 'failed', error: 'no access' })).toBe('not launched: no access');
    expect(launchOutcomeFallback({ kind: 'cancelled' })).toBeNull();
    expect(launchOutcomeFallback({ kind: 'expired', ttlMin: 1 })).toBeNull();
  });
  it('only expiry may stay silent', () => {
    expect(launchOutcomeIsMention({ kind: 'cancelled' })).toBe(true);
    expect(launchOutcomeIsMention({ kind: 'failed', error: 'x' })).toBe(true);
    expect(launchOutcomeIsMention({ kind: 'expired', ttlMin: 1 })).toBe(false);
  });
});
