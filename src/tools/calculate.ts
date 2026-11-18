/**
 * `calculate`: deterministic arithmetic, time zone conversion and date maths, so the model never does them in its
 * head (failure reports: AEDT/NZDT conversions that contradicted each other, garbled scoring). Pure, no side effects,
 * no limits needed. Logic lives in calc-expr.ts (safe expression parser) and calc-time.ts (Intl-based zones).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { registerTool } from '../core/tools.js';
import { evaluate, formatNumber } from './calc-expr.js';
import { convert, dateAdd, dateDiff, TimeError } from './calc-time.js';

const MAX_EXPRESSIONS = 50;
const MAX_CONVERSIONS = 10;

export const calculateInput = z.object({
  expressions: z
    .array(z.string())
    .max(MAX_EXPRESSIONS)
    .optional()
    .describe(
      'Arithmetic, evaluated in order: numbers, + - * / % (remainder) ^ (power), parentheses; functions min max sum avg median round(x[,digits]) floor ceil trunc abs sqrt cbrt pow exp ln log10 log2 percent(part,whole); constants pi, e. "name = expr" stores a value for later expressions (e.g. ["alice = 3*4 + 2", "bob = 15", "max(alice, bob)"]). No thousands separators.',
    ),
  convert: z
    .array(
      z.object({
        at: z.string().describe('Wall-clock time in the `from` zone: "2026-11-20 15:00", "2026-11-20 3pm", "15:00" (today), or "now"'),
        from: z.string().describe('Source zone: IANA name (Australia/Sydney), city (Auckland), offset (UTC+10) or abbreviation (AEDT, PST)'),
        to: z.array(z.string()).min(1).max(20).describe('Target zones, same forms as `from`'),
      }),
    )
    .max(MAX_CONVERSIONS)
    .optional()
    .describe('Time zone conversions. Each result gives weekday, date, 24h + 12h time, zone abbreviation and UTC offset, and flags a day change.'),
  date_diff: z
    .object({
      from: z.string().describe('Start: "2026-11-20", "2026-11-20 15:00", "now", or ISO with Z/offset'),
      to: z.string().describe('End, same forms'),
      zone: z.string().optional().describe('Zone both are read in (default UTC)'),
    })
    .optional()
    .describe('Time between two dates/times (days, hours, minutes; calendar days).'),
  date_add: z
    .object({
      at: z.string().describe('Start: "2026-11-20 15:00", "now", …'),
      zone: z.string().optional().describe('Zone (default UTC)'),
      weeks: z.number().optional(),
      days: z.number().optional(),
      hours: z.number().optional(),
      minutes: z.number().optional().describe('Negative values subtract'),
    })
    .optional()
    .describe('Add/subtract a duration. Days/weeks keep the local time across DST changes; hours/minutes add elapsed time.'),
});

export type CalculateInput = z.infer<typeof calculateInput>;

const section = (f: () => string) => {
  try {
    return f();
  } catch (err) {
    if (err instanceof TimeError) return `error: ${err.message}`;
    // Date / Intl throw RangeError for out-of-range instants; report it for this part only.
    if (err instanceof RangeError) return 'error: a date or duration is out of range';
    throw err;
  }
};

/** Run every part of a calculate call; each part reports its own errors, so one bad input doesn't hide the rest. */
export function runCalculate(input: CalculateInput, nowMs = Date.now()): string {
  const out: string[] = [];
  if (input.expressions?.length) {
    const vars = new Map<string, number>();
    for (const e of input.expressions) {
      const r = evaluate(e, vars);
      if (!r.ok) {
        out.push(`${e.trim()} → error: ${r.error}`);
        continue;
      }
      const shown = formatNumber(r.value);
      // "x = 5" echoes as "x = 5", not "x = 5 = 5"; "x = 3*4" as "x = 3*4 = 12".
      const rhs = r.name ? e.slice(e.indexOf('=') + 1).trim() : undefined;
      out.push(rhs !== undefined && Number(rhs) === r.value ? `${r.name} = ${shown}` : `${e.trim()} = ${shown}`);
    }
  }
  for (const c of input.convert ?? []) out.push(section(() => convert(c, nowMs)));
  if (input.date_diff) {
    const d = input.date_diff;
    out.push(section(() => dateDiff(d, nowMs)));
  }
  if (input.date_add) {
    const a = input.date_add;
    out.push(section(() => dateAdd(a, nowMs)));
  }
  if (!out.length) return 'Nothing to calculate: pass expressions, convert, date_diff or date_add.';
  return out.join('\n\n');
}

registerTool({
  name: 'calculate',
  roles: ['front', 'child'],
  build: () =>
    tool({
      description:
        'Exact arithmetic, time zone conversion and date maths. Use it instead of working these out in your head: any time zone conversion, "what time is X in Y", days until / between dates, adding durations, sums, averages, percentages, scores and rankings. Quote its results as given (weekday, date, time, offset). Several parts can go in one call.',
      inputSchema: calculateInput,
      execute: async (input) => runCalculate(input),
    }),
});
