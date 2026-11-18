import { describe, expect, it } from 'vitest';
import { evaluate, formatNumber } from './calc-expr.js';

const val = (s: string, vars?: Map<string, number>) => {
  const r = evaluate(s, vars);
  if (!r.ok) throw new Error(`${s}: ${r.error}`);
  return r.value;
};
const err = (s: string) => {
  const r = evaluate(s);
  if (r.ok) throw new Error(`${s} evaluated to ${r.value}`);
  return r.error;
};

describe('evaluate', () => {
  it('follows precedence and associativity', () => {
    expect(val('1 + 2 * 3')).toBe(7);
    expect(val('(1 + 2) * 3')).toBe(9);
    expect(val('10 - 4 - 3')).toBe(3);
    expect(val('100 / 10 / 5')).toBe(2);
    expect(val('2 ^ 3 ^ 2')).toBe(512);
    expect(val('2 ** 10')).toBe(1024);
    expect(val('-2 ^ 2')).toBe(-4);
    expect(val('(-2) ^ 2')).toBe(4);
    expect(val('2 ^ -1')).toBe(0.5);
    expect(val('--3')).toBe(3);
    expect(val('-(3 + 4) * 2')).toBe(-14);
    expect(val('17 % 5')).toBe(2);
    expect(val('1.5e3 + .5')).toBe(1500.5);
    expect(val('6 × 7 ÷ 2 − 1')).toBe(20);
  });

  it('has functions and constants', () => {
    expect(val('min(3, 1, 2)')).toBe(1);
    expect(val('max(3, 1, 2)')).toBe(3);
    expect(val('sum(1, 2, 3, 4)')).toBe(10);
    expect(val('avg(1, 2, 3, 4)')).toBe(2.5);
    expect(val('median(5, 1, 3)')).toBe(3);
    expect(val('median(4, 1, 3, 2)')).toBe(2.5);
    expect(val('round(2.5)')).toBe(3);
    expect(val('round(-2.5)')).toBe(-3);
    expect(val('round(1.005, 2)')).toBe(1.01);
    expect(val('round(1234, -2)')).toBe(1200);
    expect(val('floor(-1.5) + ceil(1.2)')).toBe(0);
    expect(val('sqrt(16) + abs(-3)')).toBe(7);
    expect(val('percent(45, 60)')).toBe(75);
    expect(val('ln(e)')).toBe(1);
    expect(val('log10(1000)')).toBe(3);
    expect(val('round(pi, 4)')).toBe(3.1416);
    expect(val('MAX(1, 2)')).toBe(2);
  });

  it('keeps variables across statements', () => {
    const vars = new Map<string, number>();
    expect(evaluate('alice = 3 * 4 + 2', vars)).toEqual({ ok: true, value: 14, name: 'alice' });
    val('bob = 15', vars);
    expect(val('max(alice, bob) - min(alice, bob)', vars)).toBe(1);
    expect(val('alice = alice + 10', vars)).toBe(24);
  });

  it('returns errors, never throws', () => {
    expect(err('1 / 0')).toMatch(/division by zero/);
    expect(err('5 % 0')).toMatch(/remainder by zero/);
    expect(err('sqrt(-1)')).toMatch(/negative/);
    expect(err('(1 + 2')).toMatch(/expected "\)"/);
    expect(err('1 +')).toMatch(/ended early/);
    expect(err('1,000 + 2')).toMatch(/thousands separators/);
    expect(err('foo(1)')).toMatch(/unknown function/);
    expect(err('log(10)')).toMatch(/ambiguous/);
    expect(err('x + 1')).toMatch(/unknown name "x"/);
    expect(err('2 $ 3')).toMatch(/unexpected character/);
    expect(err('')).toMatch(/empty/);
    expect(err('round(1, 2, 3)')).toMatch(/takes 1-2 arguments/);
    expect(err('min()')).toMatch(/at least 1/);
    expect(err('pi = 3')).toMatch(/built-in/);
    expect(err('10 ^ 400')).toMatch(/infinite/);
    expect(err('2 (3)')).toMatch(/unexpected/);
    expect(err('constructor')).toMatch(/unknown name/);
    expect(err('__proto__(1)')).toMatch(/unknown function/);
    expect(err('('.repeat(500) + '1' + ')'.repeat(500))).toMatch(/too (deeply|complex)|too long/);
  });

  it('formats numbers without float noise', () => {
    expect(formatNumber(val('0.1 + 0.2'))).toBe('0.3');
    expect(formatNumber(1 / 3)).toBe('0.333333333333333');
    expect(formatNumber(val('1.1 * 1.1'))).toBe('1.21');
    expect(formatNumber(123456789012)).toBe('123456789012');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(1e25)).toBe('1e+25');
  });

  it('never drops real digits', () => {
    expect(formatNumber(val('2^53'))).toBe('9007199254740992');
    expect(formatNumber(123456789012345)).toBe('123456789012345');
    expect(formatNumber(-9007199254740991)).toBe('-9007199254740991');
    expect(formatNumber(2 ** 60)).toBe('1152921504606846976');
    expect(formatNumber(1234567.89012345)).toBe('1234567.89012345');
  });

  it('explains that % is not percent when used as one', () => {
    expect(err('200*10%')).toMatch(/remainder operator, not percent.*200 \* 10 \/ 100.*percent\(30, 200\)/);
    expect(err('(200 * 10%) + 1')).toMatch(/not percent/);
    expect(val('10 % 3')).toBe(1);
    expect(val('10 % -3')).toBe(1);
  });
});
