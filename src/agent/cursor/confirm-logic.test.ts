import { describe, expect, it } from 'vitest';
import { CODING_AGENTS_PROMPT, frontSystemPrompt } from '../prompts/front.js';
import { chunkText, CODING_INSTRUCTIONS_MAX, decideLaunchClick, launchPreviewBlocks } from './confirm-logic.js';

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
});

// Review #12: the admin-only section isn't part of everyone's system prompt.
describe('front prompt', () => {
  it('keeps the coding-agent section out of the shared base prompt', () => {
    expect(frontSystemPrompt('Bot')).not.toContain('spawn_coding_agent');
    expect(CODING_AGENTS_PROMPT).toContain('spawn_coding_agent');
    expect(CODING_AGENTS_PROMPT).toContain('Launch');
  });
});
