import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
import { accessExplanation, accessModelText, decideAccess } from './access.js';
import { hcaFromCache, mapHcaResponse, planAfterCheck } from './hca.js';

const DAY = 24 * 60 * 60 * 1000;

describe('mapHcaResponse', () => {
  it('maps every known result', () => {
    expect(mapHcaResponse(200, { result: 'verified_eligible' })).toBe('verified');
    expect(mapHcaResponse(200, { result: 'verified_but_over_18' })).toBe('verified');
    expect(mapHcaResponse(200, { result: 'needs_submission' })).toBe('unverified');
    expect(mapHcaResponse(200, { result: 'not_found', note: '…' })).toBe('unverified');
    expect(mapHcaResponse(404, { result: 'not_found' })).toBe('unverified');
    expect(mapHcaResponse(200, { result: 'pending' })).toBe('pending');
    expect(mapHcaResponse(200, { result: 'rejected' })).toBe('rejected');
  });

  it('never reads errors or unknown values as unverified', () => {
    expect(mapHcaResponse(200, { result: 'verified_but_something_new' })).toBe('unknown');
    expect(mapHcaResponse(200, { status: 'verified_eligible' })).toBe('unknown');
    expect(mapHcaResponse(200, null)).toBe('unknown');
    expect(mapHcaResponse(200, 'verified_eligible')).toBe('unknown');
    expect(mapHcaResponse(500, { result: 'not_found' })).toBe('unknown');
    expect(mapHcaResponse(503, null)).toBe('unknown');
    expect(mapHcaResponse(429, { result: 'not_found' })).toBe('unknown');
    expect(mapHcaResponse(302, null)).toBe('unknown');
  });
});

describe('HCA caching rules', () => {
  const now = Date.now();
  it('uses a fresh positive, re-checks a stale one', () => {
    expect(hcaFromCache({ verified: true, checkedAt: new Date(now - DAY) }, null, now)).toEqual({ ok: true });
    expect(hcaFromCache({ verified: true, checkedAt: new Date(now - 8 * DAY) }, null, now)).toBeNull();
    expect(hcaFromCache(null, null, now)).toBeNull();
  });

  it('uses the negative cache (reason kind only)', () => {
    expect(hcaFromCache(null, 'denied', now)).toEqual({ ok: false, reason: 'denied' });
    expect(hcaFromCache(null, 'pending', now)).toEqual({ ok: false, reason: 'pending' });
    expect(hcaFromCache({ verified: true, checkedAt: new Date(now) }, 'denied', now)).toEqual({ ok: true });
  });

  it('plans writes per outcome', () => {
    expect(planAfterCheck('verified', null)).toEqual({ decision: { ok: true }, write: 'positive', negative: null });
    const un = planAfterCheck('unverified', { verified: true, checkedAt: new Date(now - 8 * DAY) });
    expect(un.decision).toEqual({ ok: false, reason: 'denied' });
    expect(un.write).toBe('delete');
    expect(un.negative?.reason).toBe('denied');
    expect(un.negative!.ttlMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(un.negative!.ttlMs).toBeLessThanOrEqual(15 * 60_000);
    const pend = planAfterCheck('pending', null);
    expect(pend.decision).toEqual({ ok: false, reason: 'pending' });
    expect(pend.write).toBe('none');
    const rej = planAfterCheck('rejected', null);
    expect(rej).toMatchObject({ decision: { ok: false, reason: 'rejected' }, write: 'delete' });
  });

  it('on errors: no cache write, no delete; a stale positive still counts, else unavailable', () => {
    expect(planAfterCheck('unknown', { verified: true, checkedAt: new Date(now - 300 * DAY) })).toEqual({ decision: { ok: true }, write: 'none', negative: null });
    expect(planAfterCheck('unknown', null)).toEqual({ decision: { ok: false, reason: 'unavailable' }, write: 'none', negative: null });
  });
});

describe('decideAccess', () => {
  const base = { disabled: false, admin: false, budgetExhausted: false, allowlisted: false, mode: 'hca_or_allowlist' as const };
  const hcaOk = vi.fn(async () => ({ ok: true as const }));
  const hcaNo = vi.fn(async () => ({ ok: false as const, reason: 'denied' as const }));

  it('kill switch first; the admin bypasses it', async () => {
    expect(await decideAccess({ ...base, disabled: true, hca: hcaOk })).toEqual({ ok: false, reason: 'disabled' });
    expect(await decideAccess({ ...base, disabled: true, admin: true, hca: hcaOk })).toEqual({ ok: true });
  });

  it('budget applies to everyone, the admin included', async () => {
    expect(await decideAccess({ ...base, budgetExhausted: true, admin: true, hca: hcaOk })).toEqual({ ok: false, reason: 'budget' });
  });

  it('admin and allowlist pass without asking HCA', async () => {
    hcaNo.mockClear();
    expect(await decideAccess({ ...base, admin: true, hca: hcaNo })).toEqual({ ok: true });
    expect(await decideAccess({ ...base, allowlisted: true, hca: hcaNo })).toEqual({ ok: true });
    expect(hcaNo).not.toHaveBeenCalled();
  });

  it('allowlist-only mode fails closed without HCA', async () => {
    hcaOk.mockClear();
    expect(await decideAccess({ ...base, mode: 'allowlist_only', hca: hcaOk })).toEqual({ ok: false, reason: 'denied' });
    expect(hcaOk).not.toHaveBeenCalled();
  });

  it('otherwise HCA decides', async () => {
    expect(await decideAccess({ ...base, hca: hcaOk })).toEqual({ ok: true });
    expect(await decideAccess({ ...base, hca: hcaNo })).toEqual({ ok: false, reason: 'denied' });
  });
});

describe('access texts', () => {
  it('the model never gets a personal reason', () => {
    for (const r of ['denied', 'pending', 'rejected', 'unavailable'] as const) {
      const t = accessModelText(r);
      expect(t).not.toMatch(/verif|age|18|reject|pending|identity/i);
      expect(t).toMatch(/privately/);
    }
    expect(accessModelText('budget')).toMatch(/month/);
    expect(accessModelText('disabled')).toMatch(/turned off/);
  });

  it('every refusal tells the model to do the work without a sandbox (create_file), without asking', () => {
    for (const r of ['denied', 'pending', 'rejected', 'unavailable', 'budget', 'disabled'] as const) {
      const t = accessModelText(r);
      expect(t).toMatch(/without a sandbox/);
      expect(t).toMatch(/create_file/);
      expect(t).toMatch(/without asking first/);
    }
  });

  it('the front prompt keeps single files out of the sandbox and falls back without one', async () => {
    const { sandboxFrontPrompt } = await import('./prompts.js');
    const p = sandboxFrontPrompt({ previews: true });
    expect(p).toMatch(/`sandbox: true` only when it needs code run/);
    expect(p).toMatch(/A single file you can write yourself \(a page, script, CSV, text\) is create_file with no sandbox/);
    expect(p).toMatch(/do the task without one where you can \(e\.g\. create_file\), without asking first/);
    expect(p).toMatch(/Live previews:/);
    // Without PREVIEW_SECRET_KEY: no preview instructions at all.
    expect(sandboxFrontPrompt({ previews: false })).not.toMatch(/preview/i);
  });

  it('the user gets the explanation', () => {
    expect(accessExplanation('denied')).toMatch(/auth\.hackclub\.com/);
    expect(accessExplanation('rejected')).toMatch(/#identity-help/);
    expect(accessExplanation('budget', new Date('2026-10-07T00:00:00Z'))).toMatch(/2026-11-01/);
  });
});
