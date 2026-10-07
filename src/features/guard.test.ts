import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
  process.env.ADMIN_USER_ID = 'UADMIN';
});
vi.mock('../db/index.js', () => ({ sql: {} }));
vi.mock('../core/redis.js', () => ({ redis: {} }));

const { evaluateEntry, subagentLimitError, limitMessage, lowQuotaLines, quotaIsLow } = await import('./guard.js');
const { shouldAutoSuspend } = await import('./reports.js');
const { limits } = await import('../config.js');
import type { GuardState, UserBlock } from './state.js';

const block = (o: Partial<UserBlock>): UserBlock => ({
  userId: 'U1',
  suspended: false,
  sendBlocked: false,
  reason: null,
  createdAt: new Date(),
  ...o,
});
const state = (o: Partial<GuardState> = {}): GuardState => ({ paused: false, disabledChannels: new Set(), blocks: new Map(), ...o });

describe('evaluateEntry', () => {
  it('lets normal users in', () => {
    expect(evaluateEntry({ state: state(), userId: 'U1', channelId: 'C1', admin: false })).toEqual({ ok: true });
  });
  it('global pause blocks everyone but the admin', () => {
    expect(evaluateEntry({ state: state({ paused: true }), userId: 'U1', admin: false })).toEqual({ ok: false, reason: 'paused' });
    expect(evaluateEntry({ state: state({ paused: true }), userId: 'UADMIN', admin: true })).toEqual({ ok: true });
  });
  it('per-channel disable applies only with a channel', () => {
    const s = state({ disabledChannels: new Set(['C1']) });
    expect(evaluateEntry({ state: s, userId: 'U1', channelId: 'C1', admin: false })).toEqual({ ok: false, reason: 'channel_disabled' });
    expect(evaluateEntry({ state: s, userId: 'U1', channelId: 'C2', admin: false })).toEqual({ ok: true });
    expect(evaluateEntry({ state: s, userId: 'U1', admin: false })).toEqual({ ok: true });
  });
  it('suspension blocks; send-block alone does not; admin bypasses', () => {
    const s = state({ blocks: new Map([['U1', block({ suspended: true })], ['U2', block({ userId: 'U2', sendBlocked: true })], ['UADMIN', block({ userId: 'UADMIN', suspended: true })]]) });
    expect(evaluateEntry({ state: s, userId: 'U1', admin: false })).toEqual({ ok: false, reason: 'suspended' });
    expect(evaluateEntry({ state: s, userId: 'U2', admin: false })).toEqual({ ok: true });
    expect(evaluateEntry({ state: s, userId: 'UADMIN', admin: true })).toEqual({ ok: true });
  });
});

describe('subagentLimitError', () => {
  it('enforces per-user then per-thread concurrency', () => {
    expect(subagentLimitError(0, 0)).toBeNull();
    expect(subagentLimitError(limits.userConcurrentSubagents - 1, limits.threadConcurrentSubagents - 1)).toBeNull();
    expect(subagentLimitError(limits.userConcurrentSubagents, 0)).toMatch(/this user already has/);
    expect(subagentLimitError(0, limits.threadConcurrentSubagents)).toMatch(/this thread already has/);
  });
});

describe('limitMessage', () => {
  it('rounds the wait up to minutes', () => {
    expect(limitMessage('searches', 60, 1)).toMatch(/about 1 min/);
    expect(limitMessage('searches', 60, 125_000)).toMatch(/about 3 min/);
  });
});

describe('shouldAutoSuspend', () => {
  const t = limits.autoSuspendReporters;
  it('suspends at the threshold of distinct reporters', () => {
    expect(shouldAutoSuspend({ distinctReporters: t - 1, alreadySuspended: false, senderIsAdmin: false })).toBe(false);
    expect(shouldAutoSuspend({ distinctReporters: t, alreadySuspended: false, senderIsAdmin: false })).toBe(true);
  });
  it('does not re-suspend or suspend the admin', () => {
    expect(shouldAutoSuspend({ distinctReporters: t, alreadySuspended: true, senderIsAdmin: false })).toBe(false);
    expect(shouldAutoSuspend({ distinctReporters: t + 5, alreadySuspended: false, senderIsAdmin: true })).toBe(false);
  });
});

describe('low-quota warnings', () => {
  it('only limits that are close (5 % left, at least 1) get a line', () => {
    expect(quotaIsLow({ max: 20, remaining: 1 })).toBe(true);
    expect(quotaIsLow({ max: 20, remaining: 2 })).toBe(false);
    expect(quotaIsLow({ max: 500, remaining: 25 })).toBe(true);
    expect(quotaIsLow({ max: 500, remaining: 26 })).toBe(false);
    expect(
      lowQuotaLines([
        { kind: 'semantic_search', noun: 'Semantic Slack searches', max: 20, remaining: 1 },
        { kind: 'websearch', noun: 'Web searches', max: 100, remaining: 0 },
        { kind: 'search', noun: 'Slack searches', max: 500, remaining: 400 },
        { kind: 'subagent', noun: 'Subagents', max: 10, remaining: 0 },
      ]).split('\n'),
    ).toEqual([
      'Semantic Slack searches: only 1 left this hour (max 20/hour).',
      'Web searches: none left this hour (max 100/hour); calls will be refused.',
      'Subagents: they already have 10 running (the max); a new spawn will be refused until one finishes.',
    ]);
    expect(lowQuotaLines([{ kind: 'fetch', noun: 'Page fetches', max: 100, remaining: 50 }])).toBe('');
  });
});
