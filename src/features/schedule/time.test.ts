import { describe, expect, it } from 'vitest';
import { formatDuration, formatInZone, parseAt, parseDuration, resolveWhen, zonedWallTimeToUtc } from './time.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

describe('parseDuration', () => {
  it.each([
    ['20m', 20 * MIN],
    ['90 minutes', 90 * MIN],
    ['2h30m', 2.5 * HOUR],
    ['2h 30m', 2.5 * HOUR],
    ['1.5h', 1.5 * HOUR],
    ['in 3 days', 3 * DAY],
    ['1 day, 4 hours', 28 * HOUR],
    ['1 day and 4 hours', 28 * HOUR],
    ['2 weeks', 14 * DAY],
    ['1 month', 30 * DAY],
    ['PT2H', 2 * HOUR],
    ['PT1H30M', 1.5 * HOUR],
    ['P1D', DAY],
    ['P1DT12H', 36 * HOUR],
    ['P2W', 14 * DAY],
    ['p1m', 30 * DAY],
  ])('%s', (s, ms) => expect(parseDuration(s)).toBe(ms));

  it.each(['', 'soon', 'tomorrow', '5', '3 fortnights', 'P', 'PT', '0m', '2h banana', '-1h'])('rejects %j', (s) => expect(parseDuration(s)).toBeNull());
});

describe('zoned wall time', () => {
  it('converts in summer and winter (DST-aware)', () => {
    expect(new Date(zonedWallTimeToUtc({ y: 2026, mo: 7, d: 1, h: 9, mi: 0 }, 'Europe/Berlin')).toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(new Date(zonedWallTimeToUtc({ y: 2026, mo: 12, d: 1, h: 9, mi: 0 }, 'Europe/Berlin')).toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(new Date(zonedWallTimeToUtc({ y: 2026, mo: 12, d: 1, h: 9, mi: 0 }, 'America/Los_Angeles')).toISOString()).toBe('2026-12-01T17:00:00.000Z');
    expect(new Date(zonedWallTimeToUtc({ y: 2026, mo: 12, d: 1, h: 9, mi: 0 }, 'Asia/Kolkata')).toISOString()).toBe('2026-12-01T03:30:00.000Z');
  });

  it('shifts a time in the spring-forward gap forward', () => {
    // Europe/Berlin 2026-03-29 02:30 does not exist → 03:30 CEST = 01:30Z.
    expect(new Date(zonedWallTimeToUtc({ y: 2026, mo: 3, d: 29, h: 2, mi: 30 }, 'Europe/Berlin')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('picks the earlier instant in the fall-back overlap', () => {
    // Europe/Berlin 2026-10-25 02:30 happens twice (CEST 00:30Z, CET 01:30Z).
    expect(new Date(zonedWallTimeToUtc({ y: 2026, mo: 10, d: 25, h: 2, mi: 30 }, 'Europe/Berlin')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('parseAt', () => {
  it('honours offsets and Z', () => {
    expect(parseAt('2026-10-09T09:00+02:00', 'America/New_York')).toEqual({ utcMs: Date.parse('2026-10-09T07:00:00Z'), hadOffset: true });
    expect(parseAt('2026-10-09T09:00:00Z', undefined)).toEqual({ utcMs: Date.parse('2026-10-09T09:00:00Z'), hadOffset: true });
    expect(parseAt('2026-10-09 09:00 -0500', undefined)).toEqual({ utcMs: Date.parse('2026-10-09T14:00:00Z'), hadOffset: true });
  });

  it('reads times without an offset in the speaker zone (UTC if unknown)', () => {
    expect(parseAt('2026-10-09T09:00', 'Europe/Berlin')).toEqual({ utcMs: Date.parse('2026-10-09T07:00:00Z'), hadOffset: false });
    expect(parseAt('2026-10-09T09:00', undefined)).toEqual({ utcMs: Date.parse('2026-10-09T09:00:00Z'), hadOffset: false });
    expect(parseAt('2026-10-09T09:00', 'Not/AZone')).toEqual({ utcMs: Date.parse('2026-10-09T09:00:00Z'), hadOffset: false });
  });

  it.each(['2026-10-09', 'friday 9am', '2026-02-30T09:00', '2026-10-09T25:00', '2026-13-01T09:00', '2026-10-09T09:00+15:00'])('rejects %j', (s) => {
    expect('error' in parseAt(s, 'UTC')).toBe(true);
  });
});

describe('resolveWhen', () => {
  const now = Date.parse('2026-10-04T10:00:00Z');
  const opts = { now, tz: 'Europe/Berlin', maxAheadMs: YEAR };

  it('resolves relative and absolute times', () => {
    expect(resolveWhen({ in: '2h' }, opts)).toEqual({ ok: true, due: new Date('2026-10-04T12:00:00Z') });
    expect(resolveWhen({ at: '2026-10-09T09:00' }, opts)).toEqual({ ok: true, due: new Date('2026-10-09T07:00:00Z') });
  });

  it('rounds to the minute', () => {
    expect(resolveWhen({ at: '2026-10-09T09:00:40Z' }, opts)).toEqual({ ok: true, due: new Date('2026-10-09T09:01:00Z') });
  });

  it('validates', () => {
    expect(resolveWhen({}, opts)).toMatchObject({ ok: false, error: expect.stringMatching(/at.*in/) });
    expect(resolveWhen({ at: '2026-10-09T09:00', in: '2h' }, opts)).toMatchObject({ ok: false, error: expect.stringMatching(/not both/) });
    expect(resolveWhen({ at: '2026-10-04T11:00' }, opts)).toMatchObject({ ok: false, error: expect.stringMatching(/past/) }); // 09:00Z
    expect(resolveWhen({ in: '2 months' }, { ...opts, maxAheadMs: 30 * DAY })).toMatchObject({ ok: false, error: expect.stringMatching(/too far/) });
    expect(resolveWhen({ in: '400 days' }, opts)).toMatchObject({ ok: false, error: expect.stringMatching(/365 days/) });
    expect(resolveWhen({ in: 'whenever' }, opts)).toMatchObject({ ok: false, error: expect.stringMatching(/duration/) });
  });
});

describe('formatting', () => {
  it('formats in a zone', () => {
    expect(formatInZone(new Date('2026-10-09T07:00:00Z'), 'Europe/Berlin')).toBe('Fri, 9 Oct 2026, 09:00 (Europe/Berlin)');
    expect(formatInZone(new Date('2026-10-09T07:00:00Z'), undefined)).toBe('Fri, 9 Oct 2026, 07:00 (UTC)');
  });

  it('formats durations with the two largest units', () => {
    expect(formatDuration(3 * DAY + 4 * HOUR + 5 * MIN)).toBe('3 days 4 hours');
    expect(formatDuration(HOUR + MIN)).toBe('1 hour 1 minute');
    expect(formatDuration(45 * MIN)).toBe('45 minutes');
    expect(formatDuration(10_000)).toBe('less than a minute');
  });
});
