/**
 * Pure time helpers for reminders and watches: parse the model's `at` (ISO-8601) / `in` (duration) input, resolve
 * wall-clock times in the speaker's IANA time zone (DST-correct, no libraries), validate, and format for echoing back.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const UNITS: Record<string, number> = {
  m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, wk: 7 * DAY, wks: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY,
  // Months are approximated as 30 days (use `at` for an exact date).
  mo: 30 * DAY, month: 30 * DAY, months: 30 * DAY,
};

/**
 * A relative duration in ms: ISO-8601 (`PT2H30M`, `P1DT2H`, `P2W`; months = 30 days) or human (`90m`, `2h30m`,
 * `1 day 4 hours`, `3 weeks`, `1.5h`). Seconds are not supported (reminders have ~1 minute precision). Null if invalid.
 */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const iso = /^p(?:(\d+(?:\.\d+)?)w)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)d)?(?:t(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?)?$/.exec(s);
  if (iso && s !== 'p' && s !== 'pt' && !s.endsWith('t')) {
    const [, w, mo, d, h, m] = iso.map((x) => (x === undefined ? 0 : Number(x)));
    const ms = w! * 7 * DAY + mo! * 30 * DAY + d! * DAY + h! * HOUR + m! * MIN;
    return ms > 0 ? Math.round(ms) : null;
  }
  const body = s.replace(/^in\s+/, '').replace(/\s*(,|and)\s*/g, ' ');
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)\s*/gy;
  let total = 0;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const unit = UNITS[m[2]!];
    if (!unit) return null;
    total += Number(m[1]) * unit;
    pos = re.lastIndex;
  }
  if (pos !== body.length || total <= 0) return null;
  return Math.round(total);
}

/** True if `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at instant `ms`, in ms (e.g. +2h for Europe/Berlin in summer). */
export function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Wall-clock time in `tz` → UTC ms. In a DST gap the time is shifted forward (02:30 → 03:30); in an overlap the
 * earlier instant wins.
 */
export function zonedWallTimeToUtc(wall: { y: number; mo: number; d: number; h: number; mi: number; s?: number }, tz: string): number {
  const guess = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s ?? 0);
  const before = tzOffsetMs(guess - DAY, tz);
  const offsets = new Set([before, tzOffsetMs(guess, tz), tzOffsetMs(guess + DAY, tz)]);
  const valid = [...offsets].map((off) => guess - off).filter((u) => u + tzOffsetMs(u, tz) === guess);
  if (valid.length) return Math.min(...valid);
  // DST gap: this wall time doesn't exist; using the offset from before the jump moves it forward.
  return guess - before;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(z|[+-]\d{2}(?::?\d{2})?)?$/i;

export type ParsedAt = { utcMs: number; hadOffset: boolean } | { error: string };

/** ISO-8601 date-time. With an offset/Z it's absolute; without one it's wall-clock time in `tz` (UTC if unknown). */
export function parseAt(raw: string, tz: string | undefined): ParsedAt {
  const m = ISO_RE.exec(raw.trim());
  if (!m) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return { error: 'Include a time of day, e.g. "2026-10-09T09:00".' };
    return { error: `Couldn't parse "${raw}" as an ISO-8601 time like "2026-10-09T09:00" or "2026-10-09T09:00+02:00".` };
  }
  const [, y, mo, d, h, mi, s, off] = m;
  const wall = { y: Number(y), mo: Number(mo), d: Number(d), h: Number(h), mi: Number(mi), s: Number(s ?? 0) };
  if (wall.mo < 1 || wall.mo > 12 || wall.d < 1 || wall.d > 31 || wall.h > 23 || wall.mi > 59 || wall.s > 59) return { error: `"${raw}" is not a valid date/time.` };
  // Reject dates like Feb 31 (Date.UTC would roll them over).
  const check = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d));
  if (check.getUTCMonth() !== wall.mo - 1) return { error: `"${raw}" is not a valid date.` };
  if (off) {
    let offMs = 0;
    if (off.toLowerCase() !== 'z') {
      const om = /^([+-])(\d{2}):?(\d{2})?$/.exec(off)!;
      offMs = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * HOUR + Number(om[3] ?? 0) * MIN);
      if (Math.abs(offMs) > 14 * HOUR) return { error: `"${off}" is not a valid UTC offset.` };
    }
    return { utcMs: Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s) - offMs, hadOffset: true };
  }
  return { utcMs: zonedWallTimeToUtc(wall, isValidTimeZone(tz) ? tz : 'UTC'), hadOffset: false };
}

export type ResolvedWhen = { ok: true; due: Date } | { ok: false; error: string };

/**
 * The tool input → a due time. Exactly one of `at` / `in`. Must be in the future (≥ ~1 minute, the firing precision)
 * and at most `maxAheadMs` out.
 */
export function resolveWhen(input: { at?: string; in?: string }, opts: { now: number; tz: string | undefined; maxAheadMs: number }): ResolvedWhen {
  const at = input.at?.trim();
  const rel = input.in?.trim();
  if (at && rel) return { ok: false, error: 'Pass either `at` or `in`, not both.' };
  if (!at && !rel) return { ok: false, error: 'Pass `at` (ISO-8601 time) or `in` (a duration like "2h" or "3 days").' };
  let dueMs: number;
  if (rel) {
    const ms = parseDuration(rel);
    if (ms == null) return { ok: false, error: `Couldn't parse the duration "${rel}". Use e.g. "45m", "2h30m", "3 days", "1 week" or ISO "PT2H".` };
    dueMs = opts.now + ms;
  } else {
    const p = parseAt(at!, opts.tz);
    if ('error' in p) return { ok: false, error: p.error };
    dueMs = p.utcMs;
  }
  // Round to the minute (fires on a 1-minute poll anyway).
  dueMs = Math.round(dueMs / MIN) * MIN;
  if (dueMs < opts.now + 30_000) {
    return { ok: false, error: `That time is in the past or less than a minute away (it is now ${formatInZone(new Date(opts.now), opts.tz)}).` };
  }
  if (dueMs > opts.now + opts.maxAheadMs) return { ok: false, error: `That's too far out: at most ${Math.round(opts.maxAheadMs / DAY)} days ahead.` };
  return { ok: true, due: new Date(dueMs) };
}

/** "Fri, 9 Oct 2026, 09:00 (Europe/Berlin)". Unknown/invalid zone → UTC. */
export function formatInZone(d: Date, tz: string | undefined): string {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `${s} (${zone})`;
}

/** "3 days 4 hours", "45 minutes", "1 hour 5 minutes" (two largest units). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN));
  const parts: [number, string][] = [
    [Math.floor(total / (24 * 60)), 'day'],
    [Math.floor((total % (24 * 60)) / 60), 'hour'],
    [total % 60, 'minute'],
  ];
  const out = parts.filter(([n]) => n > 0).slice(0, 2).map(([n, u]) => `${n} ${u}${n === 1 ? '' : 's'}`);
  return out.length ? out.join(' ') : 'less than a minute';
}
