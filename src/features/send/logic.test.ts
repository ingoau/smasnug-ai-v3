import { describe, expect, it } from 'vitest';
import { decideClick, isUuid, parseDestination, sanitizeOutgoing } from './logic.js';

describe('parseDestination', () => {
  it('recognises the current thread', () => {
    for (const s of ['thread', 'here', '', ' This thread ']) expect(parseDestination(s, 'C1')).toEqual({ kind: 'thread' });
  });
  it('parses channels', () => {
    expect(parseDestination('<#C0123ABC|general>', 'C1')).toEqual({ kind: 'channel', id: 'C0123ABC' });
    expect(parseDestination('<#C0123ABC>', 'C1')).toEqual({ kind: 'channel', id: 'C0123ABC' });
    expect(parseDestination('C0123ABC', 'C1')).toEqual({ kind: 'channel', id: 'C0123ABC' });
    expect(parseDestination('#Ship-It', 'C1')).toEqual({ kind: 'channel_name', name: 'ship-it' });
  });
  it('parses users', () => {
    expect(parseDestination('<@U0123ABC>', 'C1')).toEqual({ kind: 'user', id: 'U0123ABC' });
    expect(parseDestination('<@U0123ABC|ingo>', 'C1')).toEqual({ kind: 'user', id: 'U0123ABC' });
    expect(parseDestination('W0123ABC', 'C1')).toEqual({ kind: 'user', id: 'W0123ABC' });
  });
  it('only allows the current DM channel id', () => {
    expect(parseDestination('D0123ABC', 'D0123ABC')).toEqual({ kind: 'channel', id: 'D0123ABC' });
    expect(parseDestination('D0999ZZZ', 'D0123ABC').kind).toBe('invalid');
  });
  it('rejects junk', () => {
    expect(parseDestination('everyone', 'C1').kind).toBe('invalid');
    expect(parseDestination('<!channel>', 'C1').kind).toBe('invalid');
  });
});

describe('sanitizeOutgoing', () => {
  it('neutralises broadcast and group pings', () => {
    const out = sanitizeOutgoing('hi <!channel> and <!here|here> @everyone <!subteam^S123|@devs> <@U1>');
    expect(out).not.toMatch(/<!/);
    expect(out).not.toMatch(/(^|\s)@everyone/);
    expect(out).toContain('<@U1>');
    expect(out).toContain('@​devs');
  });
});

describe('decideClick', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const future = new Date('2026-10-03T12:03:00Z');
  const past = new Date('2026-10-03T11:59:00Z');
  const p = (o: Partial<{ requesterId: string; status: string; expiresAt: Date }> = {}) => ({
    requesterId: 'U1',
    status: 'pending',
    expiresAt: future,
    ...o,
  });

  it('allows the requester on a live pending send', () => expect(decideClick(p(), 'U1', now)).toBe('ok'));
  it('refuses other users', () => expect(decideClick(p(), 'U2', now)).toBe('wrong_user'));
  it('refuses unknown ids', () => expect(decideClick(undefined, 'U1', now)).toBe('not_found'));
  it('refuses expired sends', () => {
    expect(decideClick(p({ expiresAt: past }), 'U1', now)).toBe('expired');
    expect(decideClick(p({ status: 'expired' }), 'U1', now)).toBe('expired');
  });
  it('refuses stale clicks after send/cancel', () => {
    expect(decideClick(p({ status: 'sent' }), 'U1', now)).toBe('already_sent');
    expect(decideClick(p({ status: 'cancelled' }), 'U1', now)).toBe('cancelled');
    expect(decideClick(p({ status: 'sending' }), 'U1', now)).toBe('in_progress');
  });
  it('checks the user before revealing state', () => expect(decideClick(p({ status: 'sent' }), 'U2', now)).toBe('wrong_user'));
});

describe('isUuid', () => {
  it('validates', () => {
    expect(isUuid('7d444840-9dc0-11d1-b245-5ffdce74fad2')).toBe(true);
    expect(isUuid("1' or 1=1")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
