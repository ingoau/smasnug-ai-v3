/**
 * Time zone conversion and date maths for the `calculate` tool (pure; built-in Intl / Date only).
 *
 * Zones are IANA names (case-insensitive), a bare city from the IANA list ("Sydney", "new york"), a fixed offset
 * ("UTC+10", "GMT-5:30", "+05:45") or a common abbreviation. An abbreviation maps to its region's zone (AEDT →
 * Australia/Sydney), and the result reports the offset actually in effect, with a note when the abbreviation's DST
 * state doesn't match the date (AEDT in July: Sydney is on AEST then).
 */

export type Zone = { kind: 'iana'; id: string } | { kind: 'fixed'; minutes: number };
export interface ResolvedZone {
  zone: Zone;
  label: string;
  /** For abbreviations that name one specific offset (AEDT = +11:00): that offset, to flag a DST mismatch. */
  impliedOffset?: number;
  abbrev?: string;
  note?: string;
}
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export class TimeError extends Error {}

const H = 60;
/** abbreviation → [region zone, offset it names in minutes (undefined: generic, either DST state), extra note]. */
const ABBREVIATIONS: Record<string, [string, number | undefined, string?]> = {
  UTC: ['UTC', 0],
  GMT: ['UTC', 0],
  Z: ['UTC', 0],
  AET: ['Australia/Sydney', undefined],
  AEST: ['Australia/Sydney', 10 * H, 'Queensland (Australia/Brisbane) stays on AEST all year'],
  AEDT: ['Australia/Sydney', 11 * H],
  ACST: ['Australia/Adelaide', 9.5 * H, 'the Northern Territory (Australia/Darwin) stays on ACST all year'],
  ACDT: ['Australia/Adelaide', 10.5 * H],
  AWST: ['Australia/Perth', 8 * H],
  NZT: ['Pacific/Auckland', undefined],
  NZST: ['Pacific/Auckland', 12 * H],
  NZDT: ['Pacific/Auckland', 13 * H],
  PT: ['America/Los_Angeles', undefined],
  PST: ['America/Los_Angeles', -8 * H],
  PDT: ['America/Los_Angeles', -7 * H],
  MT: ['America/Denver', undefined],
  MST: ['America/Denver', -7 * H, 'Arizona (America/Phoenix) stays on MST all year'],
  MDT: ['America/Denver', -6 * H],
  CT: ['America/Chicago', undefined],
  CST: ['America/Chicago', -6 * H, 'CST also means China Standard Time (Asia/Shanghai, UTC+8)'],
  CDT: ['America/Chicago', -5 * H],
  ET: ['America/New_York', undefined],
  EST: ['America/New_York', -5 * H],
  EDT: ['America/New_York', -4 * H],
  AKST: ['America/Anchorage', -9 * H],
  AKDT: ['America/Anchorage', -8 * H],
  HST: ['Pacific/Honolulu', -10 * H],
  BST: ['Europe/London', 1 * H],
  UK: ['Europe/London', undefined],
  WET: ['Europe/Lisbon', 0],
  WEST: ['Europe/Lisbon', 1 * H],
  CET: ['Europe/Paris', 1 * H],
  CEST: ['Europe/Paris', 2 * H],
  EET: ['Europe/Athens', 2 * H],
  EEST: ['Europe/Athens', 3 * H],
  MSK: ['Europe/Moscow', 3 * H],
  IST: ['Asia/Kolkata', 5.5 * H, 'IST also means Irish Standard Time (Europe/Dublin) or Israel Standard Time (Asia/Jerusalem)'],
  PKT: ['Asia/Karachi', 5 * H],
  ICT: ['Asia/Bangkok', 7 * H],
  WIB: ['Asia/Jakarta', 7 * H],
  SGT: ['Asia/Singapore', 8 * H],
  HKT: ['Asia/Hong_Kong', 8 * H],
  PHT: ['Asia/Manila', 8 * H],
  AWDT: ['Australia/Perth', 9 * H],
  JST: ['Asia/Tokyo', 9 * H],
  KST: ['Asia/Seoul', 9 * H],
  BRT: ['America/Sao_Paulo', -3 * H],
  ART: ['America/Argentina/Buenos_Aires', -3 * H],
};

let ianaByCity: Map<string, string> | undefined;
function cityIndex(): Map<string, string> {
  if (!ianaByCity) {
    ianaByCity = new Map();
    for (const id of Intl.supportedValuesOf('timeZone')) {
      const city = id.split('/').pop()!.toLowerCase().replace(/_/g, ' ');
      if (!ianaByCity.has(city)) ianaByCity.set(city, id);
    }
  }
  return ianaByCity;
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const a = Math.abs(minutes);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function validIana(name: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function resolveZone(input: string): ResolvedZone {
  const raw = input.trim();
  if (!raw) throw new TimeError('empty time zone');
  const fixed = /^(?:(?:UTC|GMT|Z)\s*)?([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(raw);
  if (fixed && (/^(utc|gmt|z)/i.test(raw) || /^[+-]/.test(raw))) {
    const h = Number(fixed[2]);
    const m = Number(fixed[3] ?? 0);
    if (h > 14 || m >= 60) throw new TimeError(`"${raw}" isn't a valid UTC offset`);
    const minutes = (fixed[1] === '-' ? -1 : 1) * (h * 60 + m);
    return { zone: { kind: 'fixed', minutes }, label: `UTC${formatOffset(minutes)}` };
  }
  // Abbreviations first: some ("EST", "MST", "HST", "CET") are also legacy IANA names with fixed offsets and no DST.
  const ab = Object.hasOwn(ABBREVIATIONS, raw.toUpperCase()) ? ABBREVIATIONS[raw.toUpperCase()] : undefined;
  if (ab) {
    const [id, impliedOffset, extra] = ab;
    if (id === 'UTC') return { zone: { kind: 'iana', id: 'UTC' }, label: 'UTC' };
    return {
      zone: { kind: 'iana', id },
      label: id,
      impliedOffset,
      abbrev: raw.toUpperCase(),
      note: `${raw.toUpperCase()} read as ${id} local time${extra ? `; ${extra}` : ''}`,
    };
  }
  const iana = validIana(raw) ?? validIana(raw.replace(/\s+/g, '_'));
  if (iana) return { zone: { kind: 'iana', id: iana }, label: iana };
  const city = cityIndex().get(raw.toLowerCase().replace(/_/g, ' '));
  if (city) return { zone: { kind: 'iana', id: city }, label: city };
  throw new TimeError(`unknown time zone "${raw}": use an IANA name (Australia/Sydney, America/New_York), a city in the IANA list, an offset (UTC+10) or a common abbreviation (AEDT, PST)`);
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function wallFormatter(id: string) {
  let f = partsCache.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: id,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      era: 'short',
    });
    partsCache.set(id, f);
  }
  return f;
}

const wallToUtcMs = (w: Wall) => {
  const d = new Date(Date.UTC(2000, w.month - 1, w.day, w.hour, w.minute, w.second));
  d.setUTCFullYear(w.year); // Date.UTC maps years 0-99 to 1900-1999
  return d.getTime();
};

/** The wall-clock time in `zone` at instant `ms` (whole seconds). */
export function wallAt(ms: number, zone: Zone): Wall {
  if (zone.kind === 'fixed') {
    const d = new Date(ms + zone.minutes * 60_000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
  }
  const p: Record<string, string> = {};
  for (const part of wallFormatter(zone.id).formatToParts(new Date(ms))) p[part.type] = part.value;
  const y = Number(p.year);
  return { year: p.era === 'BC' || p.era === 'B' ? 1 - y : y, month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}

/** UTC offset in minutes in effect in `zone` at instant `ms`. */
export function offsetAt(ms: number, zone: Zone): number {
  if (zone.kind === 'fixed') return zone.minutes;
  const s = Math.floor(ms / 1000) * 1000;
  return Math.round((wallToUtcMs(wallAt(s, zone)) - s) / 60_000);
}

const sameWall = (a: Wall, b: Wall) => a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;

/**
 * The instant a wall-clock time in `zone` names. A time skipped by a DST jump is moved forward by the jump (02:30 →
 * 03:30) with a note; a repeated time (clocks go back) takes the first occurrence, with a note.
 */
export function instantFor(w: Wall, zone: Zone): { ms: number; note?: string } {
  const local = wallToUtcMs(w);
  if (zone.kind === 'fixed') return { ms: local - zone.minutes * 60_000 };
  const offsets = [...new Set([offsetAt(local - 86_400_000, zone), offsetAt(local, zone), offsetAt(local + 86_400_000, zone)])];
  const valid = [...new Set(offsets.map((o) => local - o * 60_000))].filter((ms) => sameWall(wallAt(ms, zone), w)).sort((a, b) => a - b);
  const hhmm = `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
  if (valid.length === 1) return { ms: valid[0]! };
  if (valid.length > 1) {
    return { ms: valid[0]!, note: `${hhmm} happens twice on that date in ${zone.id} (clocks go back); used the first one (UTC${formatOffset(offsetAt(valid[0]!, zone))}), the second is UTC${formatOffset(offsetAt(valid[valid.length - 1]!, zone))}` };
  }
  // Skipped (clocks jumped forward): read it with the offset in effect just before the jump.
  const before = offsetAt(local - 86_400_000, zone);
  const ms = local - before * 60_000;
  return { ms, note: `${hhmm} doesn't exist on that date in ${zone.id} (clocks jump forward); read it as ${formatWall(wallAt(ms, zone)).time}` };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const weekday = (w: Wall) => WEEKDAYS[new Date(wallToUtcMs({ ...w, hour: 12, minute: 0, second: 0 })).getUTCDay()]!;

function formatWall(w: Wall) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(w.hour)}:${pad(w.minute)}${w.second ? `:${pad(w.second)}` : ''}`;
  const h12 = w.hour % 12 || 12;
  const time12 = `${h12}${w.minute || w.second ? `:${pad(w.minute)}` : ''}${w.second ? `:${pad(w.second)}` : ''} ${w.hour < 12 ? 'am' : 'pm'}`;
  return { date: `${weekday(w)} ${w.day} ${MONTHS[w.month - 1]} ${w.year}`, time, time12, iso: `${w.year}-${pad(w.month)}-${pad(w.day)}T${time.length === 5 ? `${time}:00` : time}` };
}

/** Short zone name (AEDT, EST, BST) where ICU knows one for an English locale; undefined if only "GMT+x" exists. */
export function abbreviationAt(ms: number, zone: Zone): string | undefined {
  if (zone.kind === 'fixed') return undefined;
  if (zone.id === 'UTC' || zone.id === 'Etc/UTC') return 'UTC';
  for (const locale of ['en-US', 'en-AU', 'en-GB', 'en-NZ', 'en-IN', 'en-CA']) {
    const name = new Intl.DateTimeFormat(locale, { timeZone: zone.id, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value;
    if (name && !/^(GMT|UTC)[+-]/.test(name)) return name;
  }
  return undefined;
}

/** One line a model can quote as-is: "Friday 20 November 2026, 15:00 (3 pm) AEDT, UTC+11:00 [Australia/Sydney]". */
export function describeInstant(ms: number, rz: Pick<ResolvedZone, 'zone' | 'label'>, relativeTo?: Wall): string {
  const w = wallAt(ms, rz.zone);
  const f = formatWall(w);
  const off = offsetAt(ms, rz.zone);
  const ab = abbreviationAt(ms, rz.zone);
  let dayShift = '';
  if (relativeTo) {
    const diff = Math.round((wallToUtcMs({ ...w, hour: 0, minute: 0, second: 0 }) - wallToUtcMs({ ...relativeTo, hour: 0, minute: 0, second: 0 })) / 86_400_000);
    if (diff) dayShift = ` (${diff > 0 ? '+' : ''}${diff} day${Math.abs(diff) === 1 ? '' : 's'})`;
  }
  const zoneName = rz.zone.kind === 'iana' && rz.zone.id !== 'UTC' ? ` [${rz.zone.id}]` : '';
  return `${f.date}, ${f.time} (${f.time12})${ab && ab !== 'UTC' ? ` ${ab}` : ''}, UTC${formatOffset(off)}${zoneName}${dayShift}`;
}

export interface ParsedTime {
  /** An explicit instant ("now", or an ISO string with Z / an offset). */
  ms?: number;
  wall?: Wall;
  dateOnly: boolean;
  timeOnly: boolean;
}

/**
 * Accepts "now", "2026-11-20", "2026-11-20 15:00", "2026-11-20T15:00:30", "2026-11-20 3pm", "2026-11-20 3:30 pm",
 * a time alone ("15:00", "3pm": today in the zone), or an ISO instant with "Z" / "+11:00".
 */
export function parseDateTime(input: string): ParsedTime {
  const s = input.trim();
  if (/^now$/i.test(s)) return { ms: Date.now(), dateOnly: false, timeOnly: false };
  const m = /^(?:(\d{4})-(\d{1,2})-(\d{1,2}))?(?:(?:^|[T\s]+)(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m || (!m[1] && !m[4])) {
    throw new TimeError(`can't read "${input}" as a date/time: use YYYY-MM-DD, YYYY-MM-DD HH:MM (24h), YYYY-MM-DD 3:30pm, a time alone (15:00) or "now"`);
  }
  if (m[4] !== undefined && m[5] === undefined && !m[7]) throw new TimeError(`can't read "${input}": write the time as HH:MM or with am/pm`);
  let hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  const second = Number(m[6] ?? 0);
  const ampm = m[7]?.toLowerCase().replace(/\./g, '');
  if (ampm) {
    if (hour < 1 || hour > 12) throw new TimeError(`"${input}": with am/pm the hour must be 1-12`);
    hour = (hour % 12) + (ampm === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) throw new TimeError(`"${input}" isn't a valid time of day`);
  const year = Number(m[1] ?? 0);
  const month = Number(m[2] ?? 1);
  const day = Number(m[3] ?? 1);
  if (m[1]) {
    const check = new Date(Date.UTC(2000, month - 1, day));
    if (month < 1 || month > 12 || check.getUTCMonth() !== month - 1 || (month === 2 && day === 29 && !isLeap(year))) throw new TimeError(`"${input}" isn't a real date`);
  }
  const wall = { year, month, day, hour, minute, second };
  if (m[8]) {
    if (!m[1]) throw new TimeError(`"${input}": an offset needs a full date`);
    const off = m[8].toUpperCase() === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(-2)));
    return { ms: wallToUtcMs(wall) - off * 60_000, dateOnly: false, timeOnly: false };
  }
  return { wall, dateOnly: !m[4], timeOnly: !m[1] };
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Resolve parsed input to an instant in `rz` (a time alone means today there). Notes explain any adjustment. */
export function toInstant(p: ParsedTime, rz: ResolvedZone, nowMs = Date.now()): { ms: number; notes: string[] } {
  if (p.ms !== undefined) return { ms: p.ms, notes: [] };
  let wall = p.wall!;
  const notes: string[] = [];
  if (p.timeOnly) {
    const today = wallAt(nowMs, rz.zone);
    wall = { ...wall, year: today.year, month: today.month, day: today.day };
    notes.push(`no date given: used today in ${rz.label} (${formatWall(today).date})`);
  }
  const r = instantFor(wall, rz.zone);
  if (r.note) notes.push(r.note);
  return { ms: r.ms, notes };
}

/** If an abbreviation named a specific offset (AEDT = +11) that isn't in effect then, say what is. */
export function dstMismatchNote(ms: number, rz: ResolvedZone): string | undefined {
  if (rz.impliedOffset === undefined) return undefined;
  const actual = offsetAt(ms, rz.zone);
  if (actual === rz.impliedOffset) return undefined;
  const ab = abbreviationAt(ms, rz.zone);
  return `${rz.abbrev} (UTC${formatOffset(rz.impliedOffset)}) isn't in effect in ${rz.label} on that date: it's ${ab ?? 'local time'} (UTC${formatOffset(actual)}) then. Used ${rz.label} local time; if a fixed UTC${formatOffset(rz.impliedOffset)} was meant, pass "UTC${formatOffset(rz.impliedOffset)}" as the zone`;
}

export interface ConvertRequest {
  at: string;
  from: string;
  to: string[];
}

export function convert(req: ConvertRequest, nowMs = Date.now()): string {
  if (!req.to.length) throw new TimeError('no target zones given (to)');
  const from = resolveZone(req.from);
  const parsed = parseDateTime(req.at);
  const { ms, notes } = toInstant(parsed, from, nowMs);
  if (parsed.dateOnly) notes.unshift('no time given: used 00:00');
  const mismatch = parsed.ms === undefined ? dstMismatchNote(ms, from) : undefined;
  const lines: string[] = [];
  const src = wallAt(ms, from.zone);
  lines.push(`${req.at} in ${req.from} = ${describeInstant(ms, from)}`);
  for (const t of req.to) {
    try {
      const rz = resolveZone(t);
      lines.push(`  → ${t}: ${describeInstant(ms, rz, src)}`);
      if (rz.note && rz.impliedOffset !== undefined) {
        const tm = dstMismatchNote(ms, rz);
        if (tm) notes.push(tm);
      }
    } catch (err) {
      if (!(err instanceof TimeError)) throw err;
      lines.push(`  → ${t}: error: ${err.message}`);
    }
  }
  lines.push(`  (UTC instant: ${new Date(ms).toISOString().replace('.000Z', 'Z')})`);
  for (const n of [from.note, mismatch, ...notes].filter(Boolean)) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

export interface DiffRequest {
  from: string;
  to: string;
  zone?: string;
}

export function dateDiff(req: DiffRequest, nowMs = Date.now()): string {
  const rz = resolveZone(req.zone ?? 'UTC');
  const a = parseDateTime(req.from);
  const b = parseDateTime(req.to);
  const ia = toInstant(a, rz, nowMs);
  const ib = toInstant(b, rz, nowMs);
  const deltaMs = ib.ms - ia.ms;
  const sign = deltaMs < 0 ? '-' : '';
  const totalMin = Math.round(Math.abs(deltaMs) / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [days && `${days} day${days === 1 ? '' : 's'}`, hours && `${hours} hour${hours === 1 ? '' : 's'}`, mins && `${mins} minute${mins === 1 ? '' : 's'}`].filter(Boolean);
  const lines = [
    `from ${describeInstant(ia.ms, rz)}`,
    `to   ${describeInstant(ib.ms, rz)}`,
    `= ${sign}${parts.length ? parts.join(', ') : '0 minutes'} (${sign}${fmt(totalMin / 60)} hours, ${sign}${totalMin} minutes${days >= 7 ? `, ${sign}${fmt(totalMin / 10080)} weeks` : ''})`,
  ];
  // Calendar-day count (what "how many days until" usually means), separate from elapsed time across a DST change.
  const wa = wallAt(ia.ms, rz.zone);
  const wb = wallAt(ib.ms, rz.zone);
  const calDays = Math.round((wallToUtcMs({ ...wb, hour: 0, minute: 0, second: 0 }) - wallToUtcMs({ ...wa, hour: 0, minute: 0, second: 0 })) / 86_400_000);
  lines.push(`calendar days between the dates (in ${rz.label}): ${calDays}`);
  for (const n of [rz.note, ...ia.notes, ...ib.notes].filter(Boolean)) lines.push(`note: ${n}`);
  return lines.join('\n');
}

const fmt = (x: number) => String(Math.round(x * 100) / 100);

export interface AddRequest {
  at: string;
  zone?: string;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
}

/** Weeks / days move the calendar date (same local time across a DST change); hours / minutes add elapsed time. */
export function dateAdd(req: AddRequest, nowMs = Date.now()): string {
  const rz = resolveZone(req.zone ?? 'UTC');
  const p = parseDateTime(req.at);
  const start = toInstant(p, rz, nowMs);
  const notes = [...start.notes];
  const calDays = (req.weeks ?? 0) * 7 + (req.days ?? 0);
  if (!Number.isInteger(calDays)) throw new TimeError('weeks/days must add up to whole days (use hours for parts of a day)');
  let ms = start.ms;
  if (calDays) {
    const w = wallAt(ms, rz.zone);
    const d = new Date(wallToUtcMs(w) + calDays * 86_400_000);
    const moved = { ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const r = instantFor(moved, rz.zone);
    if (r.note) notes.push(r.note);
    ms = r.ms;
  }
  ms += ((req.hours ?? 0) * 60 + (req.minutes ?? 0)) * 60_000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new TimeError('result is out of range');
  const added = [req.weeks && `${req.weeks} weeks`, req.days && `${req.days} days`, req.hours && `${req.hours} hours`, req.minutes && `${req.minutes} minutes`].filter(Boolean).join(' + ') || 'nothing';
  const lines = [`${describeInstant(start.ms, rz)} + ${added}`, `= ${describeInstant(ms, rz)}`];
  for (const n of [rz.note, ...notes].filter(Boolean)) lines.push(`note: ${n}`);
  return lines.join('\n');
}
