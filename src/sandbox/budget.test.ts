import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { limits, sandboxPricing } from '../config.js';
import { dayStart, evaluateBudget, minutesLeft, monthStart, nextMonthStart, reserveUsd, segmentUsd } from './budget.js';
import { startRefusal } from './lifecycle.js';

describe('pricing', () => {
  it('prices a segment by cores and GiB', () => {
    expect(segmentUsd(1, 1024, 3600)).toBeCloseTo(sandboxPricing.cpuCoreHourUsd + sandboxPricing.memGibHourUsd, 6);
    expect(segmentUsd(1, 2048, 180)).toBeCloseTo((0.1419 + 2 * 0.024) / 20, 6);
    expect(segmentUsd(1, 2048, -5)).toBe(0);
  });

  it('the reserve is one maximum live segment', () => {
    expect(reserveUsd()).toBeCloseTo(segmentUsd(limits.sandboxCpuLimit, limits.sandboxMemoryLimitMiB, limits.sandboxLifetimeMs / 1000), 9);
    expect(reserveUsd()).toBeLessThan(0.5);
  });

  it('months and days are UTC', () => {
    const d = new Date('2026-12-31T23:59:00Z');
    expect(monthStart(d).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(nextMonthStart(d).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(dayStart(d).toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });
});

describe('evaluateBudget', () => {
  const base = { estUsd: 0, modalEnvUsd: null, modalWorkspaceUsd: null, budgetUsd: 20, workspaceCreditUsd: 28, reserveUsd: 0.15 };
  it('allows starts with room for a reserve', () => {
    expect(evaluateBudget(base)).toEqual({ spentUsd: 0, exhausted: false, canStart: true, warn: false });
    expect(evaluateBudget({ ...base, estUsd: 19.9 })).toMatchObject({ exhausted: false, canStart: false, warn: true });
  });
  it('uses the higher of the estimate and Modal metered cost', () => {
    expect(evaluateBudget({ ...base, estUsd: 5, modalEnvUsd: 21 })).toMatchObject({ spentUsd: 21, exhausted: true, canStart: false });
    expect(evaluateBudget({ ...base, estUsd: 21, modalEnvUsd: 1 })).toMatchObject({ spentUsd: 21, exhausted: true });
  });
  it('warns at 80 %', () => {
    expect(evaluateBudget({ ...base, estUsd: 15.9 }).warn).toBe(false);
    expect(evaluateBudget({ ...base, estUsd: 16 }).warn).toBe(true);
  });
  it('stops on the whole workspace credit too (dev + prod share it)', () => {
    expect(evaluateBudget({ ...base, estUsd: 1, modalWorkspaceUsd: 28 })).toMatchObject({ exhausted: true, canStart: false });
    expect(evaluateBudget({ ...base, estUsd: 1, modalWorkspaceUsd: 27.9 })).toMatchObject({ exhausted: false, canStart: false, warn: true });
  });
});

describe('quotas', () => {
  const ok = { canStart: true, userLive: 0, globalLive: 0, userMinutes: 0 };
  it('passes under every cap', () => expect(startRefusal(ok)).toBeNull());
  it('refuses at each cap', () => {
    expect(startRefusal({ ...ok, canStart: false })).toMatch(/next month/);
    expect(startRefusal({ ...ok, userLive: limits.userLiveSandboxes })).toMatch(/live sandboxes/);
    expect(startRefusal({ ...ok, globalLive: limits.globalLiveSandboxes })).toMatch(/busy/);
    expect(startRefusal({ ...ok, userMinutes: limits.userSandboxMinutesPerDay })).toMatch(/minutes/);
    expect(startRefusal({ ...ok, userLive: limits.userLiveSandboxes - 1, userMinutes: limits.userSandboxMinutesPerDay - 0.5 })).toBeNull();
  });
  it('minutes left', () => {
    expect(minutesLeft(10, 30)).toBe(20);
    expect(minutesLeft(31, 30)).toBe(-1);
  });
});
