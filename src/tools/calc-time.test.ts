import { describe, expect, it } from 'vitest';
import { convert, dateAdd, dateDiff, instantFor, offsetAt, parseDateTime, resolveZone, TimeError } from './calc-time.js';
import { runCalculate } from './calculate.js';

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-11-18T01:00:00Z');

describe('resolveZone', () => {
  it('accepts IANA names, cities, offsets and abbreviations', () => {
    expect(resolveZone('Australia/Sydney').zone).toEqual({ kind: 'iana', id: 'Australia/Sydney' });
    expect(resolveZone('australia/sydney').zone).toEqual({ kind: 'iana', id: 'Australia/Sydney' });
    expect(resolveZone('America/New York').zone).toEqual({ kind: 'iana', id: 'America/New_York' });
    expect(resolveZone('Auckland').zone).toEqual({ kind: 'iana', id: 'Pacific/Auckland' });
    expect(resolveZone('new york').zone).toEqual({ kind: 'iana', id: 'America/New_York' });
    expect(resolveZone('UTC+10').zone).toEqual({ kind: 'fixed', minutes: 600 });
    expect(resolveZone('GMT-5:30').zone).toEqual({ kind: 'fixed', minutes: -330 });
    expect(resolveZone('+05:45').zone).toEqual({ kind: 'fixed', minutes: 345 });
    expect(resolveZone('utc').zone).toEqual({ kind: 'iana', id: 'UTC' });
    // Abbreviations map to the region (not the fixed-offset legacy IANA "EST" / "MST").
    expect(resolveZone('AEDT').zone).toEqual({ kind: 'iana', id: 'Australia/Sydney' });
    expect(resolveZone('nzdt').zone).toEqual({ kind: 'iana', id: 'Pacific/Auckland' });
    expect(resolveZone('EST').zone).toEqual({ kind: 'iana', id: 'America/New_York' });
    expect(resolveZone('PST').zone).toEqual({ kind: 'iana', id: 'America/Los_Angeles' });
  });

  it('rejects unknown zones and bad offsets', () => {
    expect(() => resolveZone('Mars/Olympus_Mons')).toThrow(TimeError);
    expect(() => resolveZone('XYZT')).toThrow(/unknown time zone/);
    expect(() => resolveZone('UTC+15')).toThrow(/valid UTC offset/);
    expect(() => resolveZone('constructor')).toThrow(TimeError);
    expect(() => resolveZone('')).toThrow(TimeError);
  });
});

describe('parseDateTime', () => {
  it('reads the documented forms', () => {
    expect(parseDateTime('2026-11-20 15:00').wall).toMatchObject({ year: 2026, month: 11, day: 20, hour: 15, minute: 0 });
    expect(parseDateTime('2026-11-20T15:30:10').wall).toMatchObject({ hour: 15, minute: 30, second: 10 });
    expect(parseDateTime('2026-11-20 3pm').wall).toMatchObject({ hour: 15 });
    expect(parseDateTime('2026-11-20 12am').wall).toMatchObject({ hour: 0 });
    expect(parseDateTime('2026-11-20 12:30 p.m.').wall).toMatchObject({ hour: 12, minute: 30 });
    expect(parseDateTime('2026-11-20')).toMatchObject({ dateOnly: true });
    expect(parseDateTime('9:15')).toMatchObject({ timeOnly: true, wall: { hour: 9, minute: 15 } });
    expect(iso(parseDateTime('2026-11-20T15:00Z').ms!)).toBe('2026-11-20T15:00:00.000Z');
    expect(iso(parseDateTime('2026-11-20T15:00+11:00').ms!)).toBe('2026-11-20T04:00:00.000Z');
    expect(parseDateTime('2028-02-29').wall).toMatchObject({ month: 2, day: 29 });
  });

  it('rejects bad dates and times', () => {
    expect(() => parseDateTime('2026-02-30')).toThrow(/real date/);
    expect(() => parseDateTime('2026-02-29')).toThrow(/real date/);
    expect(() => parseDateTime('2026-13-01')).toThrow(/real date/);
    expect(() => parseDateTime('2026-11-20 25:00')).toThrow(/valid time/);
    expect(() => parseDateTime('2026-11-20 13pm')).toThrow(/1-12/);
    expect(() => parseDateTime('next tuesday')).toThrow(/can't read/);
    expect(() => parseDateTime('20/11/2026')).toThrow(/can't read/);
  });
});

describe('instantFor (DST edges)', () => {
  const ny = { kind: 'iana', id: 'America/New_York' } as const;
  const syd = { kind: 'iana', id: 'Australia/Sydney' } as const;
  const w = (year: number, month: number, day: number, hour: number, minute = 0) => ({ year, month, day, hour, minute, second: 0 });

  it('handles ordinary times either side of a change', () => {
    expect(iso(instantFor(w(2026, 3, 8, 1, 59), ny).ms)).toBe('2026-03-08T06:59:00.000Z');
    expect(iso(instantFor(w(2026, 3, 8, 3, 0), ny).ms)).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(instantFor(w(2026, 4, 5, 12), syd).ms)).toBe('2026-04-05T02:00:00.000Z'); // AEST after the change
    expect(iso(instantFor(w(2026, 4, 4, 12), syd).ms)).toBe('2026-04-04T01:00:00.000Z'); // AEDT the day before
  });

  it('moves a skipped time forward with a note', () => {
    const r = instantFor(w(2026, 3, 8, 2, 30), ny);
    expect(iso(r.ms)).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
    expect(r.note).toMatch(/doesn't exist.*03:30/);
    const s = instantFor(w(2026, 10, 4, 2, 30), syd);
    expect(iso(s.ms)).toBe('2026-10-03T16:30:00.000Z'); // 03:30 AEDT
    expect(s.note).toMatch(/clocks jump forward/);
  });

  it('takes the first of a repeated time, with a note', () => {
    const r = instantFor(w(2026, 11, 1, 1, 30), ny);
    expect(iso(r.ms)).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT, not EST
    expect(r.note).toMatch(/happens twice.*UTC-04:00.*UTC-05:00/);
  });

  it('handles a skipped calendar day (Samoa, Dec 2011)', () => {
    const r = instantFor(w(2011, 12, 30, 12), { kind: 'iana', id: 'Pacific/Apia' });
    expect(r.note).toMatch(/doesn't exist/);
  });

  it('reports offsets', () => {
    expect(offsetAt(Date.parse('2026-01-15T00:00Z'), syd)).toBe(660);
    expect(offsetAt(Date.parse('2026-07-15T00:00Z'), syd)).toBe(600);
    expect(offsetAt(Date.parse('2026-07-15T00:00Z'), { kind: 'iana', id: 'Asia/Kathmandu' })).toBe(345);
  });
});

describe('convert', () => {
  it('converts Sydney to Auckland and New York across the date line', () => {
    const out = convert({ at: '2026-11-20 15:00', from: 'Australia/Sydney', to: ['Pacific/Auckland', 'America/New_York', 'UTC'] }, NOW);
    expect(out).toContain('= Friday 20 November 2026, 15:00 (3 pm) AEDT, UTC+11:00 [Australia/Sydney]');
    expect(out).toContain('Pacific/Auckland: Friday 20 November 2026, 17:00 (5 pm) NZDT, UTC+13:00');
    expect(out).toContain('America/New_York: Thursday 19 November 2026, 23:00 (11 pm) EST, UTC-05:00 [America/New_York] (-1 day)');
    expect(out).toContain('UTC: Friday 20 November 2026, 04:00 (4 am), UTC+00:00');
    expect(out).toContain('UTC instant: 2026-11-20T04:00:00Z');
  });

  it('Auckland morning is the previous afternoon in New York', () => {
    const out = convert({ at: '2026-11-20 9am', from: 'NZDT', to: ['ET', 'Los Angeles'] }, NOW);
    expect(out).toContain('ET: Thursday 19 November 2026, 15:00 (3 pm) EST, UTC-05:00');
    expect(out).toContain('Los Angeles: Thursday 19 November 2026, 12:00 (12 pm) PST, UTC-08:00');
  });

  it('flags an abbreviation whose DST state does not match the date', () => {
    const out = convert({ at: '2026-07-10 15:00', from: 'AEDT', to: ['UTC'] }, NOW);
    expect(out).toContain('AEST, UTC+10:00');
    expect(out).toMatch(/AEDT \(UTC\+11:00\) isn't in effect in Australia\/Sydney.*AEST \(UTC\+10:00\)/);
    expect(out).toContain('UTC: Friday 10 July 2026, 05:00 (5 am)');
    expect(convert({ at: '2026-01-10 15:00', from: 'AEDT', to: ['UTC'] }, NOW)).not.toMatch(/isn't in effect/);
  });

  it('respects a fixed offset when one is asked for', () => {
    const out = convert({ at: '2026-07-10 15:00', from: 'UTC+11', to: ['Australia/Sydney'] }, NOW);
    expect(out).toContain('Australia/Sydney: Friday 10 July 2026, 14:00 (2 pm) AEST, UTC+10:00');
  });

  it('reads a time alone as today in the source zone', () => {
    const out = convert({ at: '18:00', from: 'Australia/Sydney', to: ['London'] }, NOW);
    expect(out).toContain('Wednesday 18 November 2026, 18:00');
    expect(out).toContain('London: Wednesday 18 November 2026, 07:00 (7 am) GMT');
    expect(out).toMatch(/no date given/);
  });

  it('reports a bad target without losing the others', () => {
    const out = convert({ at: '2026-11-20 15:00', from: 'UTC', to: ['Nowhere/Land', 'Asia/Tokyo'] }, NOW);
    expect(out).toMatch(/Nowhere\/Land: error: unknown time zone/);
    expect(out).toContain('Asia/Tokyo: Saturday 21 November 2026, 00:00 (12 am)');
  });
});

describe('dateDiff / dateAdd', () => {
  it('separates elapsed time from calendar days across DST', () => {
    const out = dateDiff({ from: '2026-03-07 12:00', to: '2026-03-09 12:00', zone: 'America/New_York' }, NOW);
    expect(out).toContain('= 1 day, 23 hours (47 hours, 2820 minutes)');
    expect(out).toContain('calendar days between the dates (in America/New_York): 2');
  });

  it('counts days between dates, negative when reversed', () => {
    expect(dateDiff({ from: '2026-11-18', to: '2026-12-25' }, NOW)).toContain('= 37 days (888 hours, 53280 minutes, 5.29 weeks)');
    expect(dateDiff({ from: '2026-12-25', to: '2026-11-18' }, NOW)).toContain('= -37 days');
  });

  it('adds calendar days keeping local time, hours as elapsed time', () => {
    expect(dateAdd({ at: '2026-03-07 12:00', zone: 'America/New_York', days: 1 }, NOW)).toContain('= Sunday 8 March 2026, 12:00 (12 pm) EDT');
    expect(dateAdd({ at: '2026-03-07 12:00', zone: 'America/New_York', hours: 24 }, NOW)).toContain('= Sunday 8 March 2026, 13:00 (1 pm) EDT');
    expect(dateAdd({ at: '2026-11-20', weeks: 2, days: -1 }, NOW)).toContain('= Thursday 3 December 2026');
    expect(dateAdd({ at: '2026-01-31 10:00', zone: 'UTC', minutes: -90 }, NOW)).toContain('= Saturday 31 January 2026, 08:30');
    expect(() => dateAdd({ at: '2026-01-31', days: 1.5 }, NOW)).toThrow(/whole days/);
  });
});

describe('runCalculate', () => {
  it('runs every part and keeps errors local', () => {
    const out = runCalculate(
      {
        expressions: ['a = 2 + 3', 'a * 2', '1 / 0'],
        convert: [{ at: '2026-11-20 15:00', from: 'Mars', to: ['UTC'] }],
        date_diff: { from: '2026-11-18', to: '2026-11-20' },
      },
      NOW,
    );
    expect(out).toContain('a = 2 + 3 = 5');
    expect(out).toContain('a * 2 = 10');
    expect(out).toContain('1 / 0 → error: division by zero');
    expect(out).toMatch(/error: unknown time zone "Mars"/);
    expect(out).toContain('= 2 days');
  });

  it('says so when given nothing', () => {
    expect(runCalculate({}, NOW)).toMatch(/Nothing to calculate/);
  });
});
