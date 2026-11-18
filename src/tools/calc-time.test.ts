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

  it('knows current IANA names and big cities, and shows the modern name', () => {
    const id = (z: string) => (resolveZone(z).zone as { id: string }).id;
    expect(id('Kolkata')).toBe('Asia/Kolkata');
    expect(id('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(id('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(id('Kyiv')).toBe('Europe/Kyiv');
    expect(id('kiev')).toBe('Europe/Kyiv');
    expect(id('Ho Chi Minh')).toBe('Asia/Ho_Chi_Minh');
    expect(id('Kathmandu')).toBe('Asia/Kathmandu');
    expect(id('Yangon')).toBe('Asia/Yangon');
    expect(id('Nuuk')).toBe('America/Nuuk');
    expect(id('Mumbai')).toBe('Asia/Kolkata');
    expect(id('new delhi')).toBe('Asia/Kolkata');
    expect(id('Bengaluru')).toBe('Asia/Kolkata');
    expect(resolveZone('Asia/Kolkata').label).toBe('Asia/Kolkata');
    const out = convert({ at: '2026-11-20 04:00', from: 'UTC', to: ['Kolkata'] }, NOW);
    expect(out).toContain('Kolkata: Friday 20 November 2026, 09:30 (9:30 am) IST, UTC+05:30 [Asia/Kolkata]');
    expect(out).not.toContain('Calcutta');
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

  it('accepts ISO instants with fractional seconds', () => {
    expect(iso(parseDateTime('2026-11-20T04:00:00.000Z').ms!)).toBe('2026-11-20T04:00:00.000Z');
    expect(iso(parseDateTime('2026-11-20T04:00:00.250+11:00').ms!)).toBe('2026-11-19T17:00:00.250Z');
    expect(iso(parseDateTime('2026-11-20T04:00:00.123456Z').ms!)).toBe('2026-11-20T04:00:00.123Z');
    expect(parseDateTime('2026-11-20T04:00:05.9').wall).toMatchObject({ hour: 4, minute: 0, second: 5 });
    expect(convert({ at: '2026-11-20T04:00:00.000Z', from: 'UTC', to: ['Australia/Sydney'] }, NOW)).toContain('Friday 20 November 2026, 15:00 (3 pm) AEDT');
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

  it('picks the occurrence of a repeated wall time that the abbreviation names', () => {
    // Sydney clocks go back 03:00 AEDT → 02:00 AEST on 5 April 2026, so 02:30 happens twice.
    const aest = convert({ at: '2026-04-05 02:30', from: 'AEST', to: ['UTC'] }, NOW);
    expect(aest).toContain('(UTC instant: 2026-04-04T16:30:00Z)');
    expect(aest).not.toMatch(/isn't in effect/);
    expect(aest).toMatch(/used the UTC\+10:00 one the abbreviation names/);
    const aedt = convert({ at: '2026-04-05 02:30', from: 'AEDT', to: ['UTC'] }, NOW);
    expect(aedt).toContain('(UTC instant: 2026-04-04T15:30:00Z)');
    expect(aedt).not.toMatch(/isn't in effect/);
    // A zone name (no implied offset) still takes the first occurrence.
    expect(convert({ at: '2026-04-05 02:30', from: 'Australia/Sydney', to: ['UTC'] }, NOW)).toContain('(UTC instant: 2026-04-04T15:30:00Z)');
  });

  it('notes how a target abbreviation was read, like a source one', () => {
    const out = convert({ at: '2026-11-20 04:00', from: 'UTC', to: ['CST', 'IST'] }, NOW);
    expect(out).toMatch(/note: CST read as America\/Chicago local time; CST also means China Standard Time/);
    expect(out).toMatch(/note: IST read as Asia\/Kolkata local time; IST also means Irish Standard Time/);
    // A target abbreviation whose DST state doesn't match the date gets the mismatch note too.
    expect(convert({ at: '2026-07-10 04:00', from: 'UTC', to: ['AEDT'] }, NOW)).toMatch(/AEDT \(UTC\+11:00\) isn't in effect/);
    // Same abbreviation on both sides: the note appears once.
    const twice = convert({ at: '2026-11-20 04:00', from: 'CST', to: ['CST'] }, NOW);
    expect(twice.match(/CST read as/g)).toHaveLength(1);
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

  it('rejects durations too large to represent, as a TimeError', () => {
    expect(() => dateAdd({ at: '2026-01-01', days: 1e9 }, NOW)).toThrow(TimeError);
    expect(() => dateAdd({ at: '2026-01-01', hours: 1e15 }, NOW)).toThrow(/out of range/);
    expect(() => dateAdd({ at: '2026-01-01', weeks: 1e12 }, NOW)).toThrow(/out of range/);
    expect(dateAdd({ at: '2026-01-01', days: 365 }, NOW)).toContain('= Friday 1 January 2027');
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

  it('an out-of-range date_add is a section error, not a failed call', () => {
    const out = runCalculate({ expressions: ['1 + 1'], date_add: { at: '2026-01-01', days: 1e9 } }, NOW);
    expect(out).toContain('1 + 1 = 2');
    expect(out).toMatch(/error: duration is out of range/);
  });

  it('echoes an assignment once', () => {
    const out = runCalculate({ expressions: ['x = 5', 'y = x * 2', 'z = -1.5'] }, NOW);
    expect(out).toContain('x = 5\n');
    expect(out).not.toContain('x = 5 = 5');
    expect(out).toContain('y = x * 2 = 10');
    expect(out).toContain('z = -1.5');
    expect(out).not.toContain('z = -1.5 = -1.5');
  });

  it('says so when given nothing', () => {
    expect(runCalculate({}, NOW)).toMatch(/Nothing to calculate/);
  });
});
