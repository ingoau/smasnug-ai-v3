/**
 * A small, safe arithmetic evaluator for the `calculate` tool (pure; never eval / Function).
 *
 * Grammar (usual precedence, `^` / `**` right-associative and binding tighter than unary minus, so -2^2 = -4):
 *   statement := [name '='] expr
 *   expr      := term (('+' | '-') term)*
 *   term      := unary (('*' | '/' | '%') unary)*        // % is the remainder
 *   unary     := ('-' | '+') unary | power
 *   power     := primary (('^' | '**') unary)?
 *   primary   := number | name | name '(' [expr (',' expr)*] ')' | '(' expr ')'
 * Names are constants (pi, e), variables assigned earlier in the same call, or functions (FUNCTIONS).
 */

export type CalcResult = { ok: true; value: number; name?: string } | { ok: false; error: string };

const MAX_LENGTH = 1000;
const MAX_DEPTH = 100;

type Token =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'name'; value: string; pos: number }
  | { kind: 'op'; value: string; pos: number }
  | { kind: 'end'; pos: number };

class CalcError extends Error {}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
/** Own-property lookup only ("constructor", "__proto__" are not functions or constants). */
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

const needArgs = (name: string, args: number[], min: number, max = min) => {
  if (args.length < min || args.length > max) {
    const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}-${max}`;
    throw new CalcError(`${name}() takes ${want} argument${min === 1 && max === 1 ? '' : 's'}, got ${args.length}`);
  }
};
const unary = (name: string, f: (x: number) => number) => (args: number[]) => {
  needArgs(name, args, 1);
  return f(args[0]!);
};
const list = (name: string, f: (xs: number[]) => number) => (args: number[]) => {
  needArgs(name, args, 1, Infinity);
  return f(args);
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
/** Rounds half away from zero (2.5 → 3, -2.5 → -3), to `digits` decimal places (negative: tens, hundreds…). */
const roundTo = (x: number, digits: number) => {
  if (!Number.isInteger(digits) || Math.abs(digits) > 15) throw new CalcError('round() digits must be a whole number between -15 and 15');
  const f = 10 ** digits;
  // toPrecision first so 1.005 (stored as 1.00499…) rounds the way people expect.
  const scaled = Number((Math.abs(x) * f).toPrecision(15));
  return (Math.sign(x) * Math.round(scaled)) / f;
};

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  min: list('min', (xs) => Math.min(...xs)),
  max: list('max', (xs) => Math.max(...xs)),
  sum: list('sum', sum),
  avg: list('avg', (xs) => sum(xs) / xs.length),
  mean: list('mean', (xs) => sum(xs) / xs.length),
  median: list('median', median),
  round: (args) => {
    needArgs('round', args, 1, 2);
    return roundTo(args[0]!, args[1] ?? 0);
  },
  floor: unary('floor', Math.floor),
  ceil: unary('ceil', Math.ceil),
  trunc: unary('trunc', Math.trunc),
  abs: unary('abs', Math.abs),
  sqrt: unary('sqrt', (x) => {
    if (x < 0) throw new CalcError('sqrt() of a negative number');
    return Math.sqrt(x);
  }),
  cbrt: unary('cbrt', Math.cbrt),
  exp: unary('exp', Math.exp),
  ln: unary('ln', (x) => logOf('ln', x, Math.log)),
  log10: unary('log10', (x) => logOf('log10', x, Math.log10)),
  log2: unary('log2', (x) => logOf('log2', x, Math.log2)),
  pow: (args) => {
    needArgs('pow', args, 2);
    return args[0]! ** args[1]!;
  },
  percent: (args) => {
    needArgs('percent', args, 2);
    if (args[1] === 0) throw new CalcError('percent(part, whole): whole is 0');
    return (args[0]! / args[1]!) * 100;
  },
};

function logOf(name: string, x: number, f: (x: number) => number) {
  if (x <= 0) throw new CalcError(`${name}() needs a positive number`);
  return f(x);
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ kind: 'num', value: Number(num[0]), pos: i });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) {
      out.push({ kind: 'name', value: name[0], pos: i });
      i += name[0].length;
      continue;
    }
    if (src.startsWith('**', i)) {
      out.push({ kind: 'op', value: '^', pos: i });
      i += 2;
      continue;
    }
    const op = ({ '×': '*', '·': '*', '÷': '/', '−': '-' } as Record<string, string>)[c] ?? c;
    if ('+-*/%^(),='.includes(op)) {
      out.push({ kind: 'op', value: op, pos: i });
      i++;
      continue;
    }
    throw new CalcError(`unexpected character "${c}" at position ${i + 1}`);
  }
  out.push({ kind: 'end', pos: src.length });
  return out;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly vars: Map<string, number>,
  ) {}

  private peek() {
    return this.tokens[this.i]!;
  }
  private isOp(v: string) {
    const t = this.peek();
    return t.kind === 'op' && t.value === v;
  }
  private expectOp(v: string, context: string) {
    if (!this.isOp(v)) throw new CalcError(`expected "${v}" ${context} at position ${this.peek().pos + 1}`);
    this.i++;
  }

  statement(): { value: number; name?: string } {
    let name: string | undefined;
    const t0 = this.tokens[0]!;
    const t1 = this.tokens[1];
    if (t0.kind === 'name' && t1?.kind === 'op' && t1.value === '=') {
      name = t0.value;
      if (own(CONSTANTS, name.toLowerCase()) !== undefined || own(FUNCTIONS, name.toLowerCase())) throw new CalcError(`can't assign to "${name}" (a built-in name)`);
      this.i = 2;
    }
    const value = this.expr();
    const end = this.peek();
    if (end.kind !== 'end') {
      if (end.kind === 'op' && end.value === ',') throw new CalcError(`unexpected "," at position ${end.pos + 1} (don't use thousands separators: write 1000, not 1,000)`);
      if (end.kind === 'op' && end.value === '=') throw new CalcError(`unexpected "=" at position ${end.pos + 1} (assign as "name = expression")`);
      throw new CalcError(`unexpected "${end.kind === 'num' ? end.value : (end as { value: string }).value}" at position ${end.pos + 1}`);
    }
    return { value, name };
  }

  private expr(): number {
    if (++this.depth > MAX_DEPTH) throw new CalcError('expression is nested too deeply');
    let v = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.i++] as { value: string }).value;
      const r = this.term();
      v = op === '+' ? v + r : v - r;
    }
    this.depth--;
    return v;
  }

  private term(): number {
    let v = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.tokens[this.i++] as { value: string }).value;
      if (op === '%') {
        // "200 * 10%" (nothing after the %): people mean percent, which this grammar doesn't have.
        const next = this.peek();
        if (next.kind === 'end' || (next.kind === 'op' && ')*/%^,='.includes(next.value))) {
          throw new CalcError('"%" is the remainder operator, not percent: for 10% of 200 write 200 * 10 / 100; for what percent 30 is of 200 write percent(30, 200)');
        }
      }
      const r = this.unary();
      if (op === '*') v *= r;
      else {
        if (r === 0) throw new CalcError(op === '/' ? 'division by zero' : 'remainder by zero');
        v = op === '/' ? v / r : v % r;
      }
    }
    return v;
  }

  private unary(): number {
    if (++this.depth > MAX_DEPTH) throw new CalcError('expression is nested too deeply');
    let v: number;
    if (this.isOp('-')) {
      this.i++;
      v = -this.unary();
    } else if (this.isOp('+')) {
      this.i++;
      v = this.unary();
    } else v = this.power();
    this.depth--;
    return v;
  }

  private power(): number {
    const base = this.primary();
    if (this.isOp('^')) {
      this.i++;
      const exp = this.unary();
      return base ** exp;
    }
    return base;
  }

  private primary(): number {
    const t = this.peek();
    if (t.kind === 'num') {
      this.i++;
      return t.value;
    }
    if (t.kind === 'name') {
      this.i++;
      const key = t.value;
      if (this.isOp('(')) {
        this.i++;
        const fn = own(FUNCTIONS, key.toLowerCase());
        if (!fn) {
          if (key.toLowerCase() === 'log') throw new CalcError('log() is ambiguous: use ln (natural), log10 or log2');
          throw new CalcError(`unknown function "${key}" (have: ${Object.keys(FUNCTIONS).join(', ')})`);
        }
        const args: number[] = [];
        if (!this.isOp(')')) {
          args.push(this.expr());
          while (this.isOp(',')) {
            this.i++;
            args.push(this.expr());
          }
        }
        this.expectOp(')', `to close ${key}(`);
        return fn(args);
      }
      if (this.vars.has(key)) return this.vars.get(key)!;
      const c = own(CONSTANTS, key.toLowerCase());
      if (c !== undefined) return c;
      if (own(FUNCTIONS, key.toLowerCase())) throw new CalcError(`${key} is a function: write ${key}(…)`);
      throw new CalcError(`unknown name "${key}"`);
    }
    if (t.kind === 'op' && t.value === '(') {
      this.i++;
      const v = this.expr();
      this.expectOp(')', 'to close "("');
      return v;
    }
    if (t.kind === 'end') throw new CalcError('expression ended early');
    throw new CalcError(`unexpected "${t.value}" at position ${t.pos + 1}`);
  }
}

/** Evaluate one statement. `vars` carries assignments across a call's statements (and is updated in place). */
export function evaluate(src: string, vars: Map<string, number> = new Map()): CalcResult {
  try {
    const text = src.trim();
    if (!text) return { ok: false, error: 'empty expression' };
    if (text.length > MAX_LENGTH) return { ok: false, error: `expression is too long (max ${MAX_LENGTH} characters)` };
    const { value, name } = new Parser(tokenize(text), vars).statement();
    if (Number.isNaN(value)) return { ok: false, error: 'result is not a number' };
    if (!Number.isFinite(value)) return { ok: false, error: 'result is infinite (overflow)' };
    if (name) vars.set(name, value);
    return { ok: true, value, name };
  } catch (err) {
    if (err instanceof CalcError) return { ok: false, error: err.message };
    if (err instanceof RangeError) return { ok: false, error: 'expression is too complex' };
    throw err;
  }
}

/**
 * A number as people write it: float noise trimmed (0.1 + 0.2 → 0.3), no exponent for ordinary magnitudes. Integers
 * print exactly (2^53 → 9007199254740992); other values keep 15 significant digits, all a double reliably holds.
 */
export function formatNumber(x: number): string {
  if (Object.is(x, -0)) x = 0;
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return BigInt(x).toString();
  const clean = Number(x.toPrecision(15));
  const abs = Math.abs(clean);
  if (abs !== 0 && (abs >= 1e21 || abs < 1e-9)) return clean.toExponential().replace(/\.?0+e/, 'e');
  return clean.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}
