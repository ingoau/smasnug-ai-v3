import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../../db/index.js', () => ({ sql: {} }));
vi.mock('../../core/redis.js', () => ({ redis: {} }));
import { cleanCategories } from './categories.js';
import { renderReviewTranscript, reviewReason, validateFindings, type Finding, type Line } from './review.js';

const base = { flags: [], selfReports: 0, gate: [], humanMessages: [], sampleRate: 0, rand: () => 0.5 };

describe('cleanCategories', () => {
  it('dedupes, drops unknown ones, and drops other next to a specific one', () => {
    expect(cleanCategories(['incomplete', 'incomplete', 'nope', 'other'])).toEqual(['incomplete']);
    expect(cleanCategories(['other'])).toEqual(['other']);
    expect(cleanCategories(['incorrect_info', 'incomplete', 'missed_context', 'too_slow'])).toHaveLength(3);
  });
});

describe('reviewReason', () => {
  it('reviews threads with a warning flag or a self report', () => {
    expect(reviewReason({ ...base, flags: ['many_steps', 'user_correction'] })).toMatch(/user_correction/);
    expect(reviewReason({ ...base, selfReports: 1 })).toBe('self report');
  });

  it('ignores flags people never see', () => {
    expect(reviewReason({ ...base, flags: ['many_steps', 'skill_late', 'slow_first_text'] })).toBeNull();
  });

  it('reviews a gate "no" its author followed up on within 30 min, or a near miss', () => {
    const gate = [{ messageTs: '1000.000100', authorId: 'U1', decision: 'no' as const, probability: 0.1 }];
    expect(reviewReason({ ...base, gate, humanMessages: [{ ts: '1600.000000', userId: 'U1' }] })).toMatch(/followed up/);
    expect(reviewReason({ ...base, gate, humanMessages: [{ ts: '1600.000000', userId: 'U2' }] })).toBeNull();
    expect(reviewReason({ ...base, gate, humanMessages: [{ ts: '9000.000000', userId: 'U1' }] })).toBeNull();
    expect(reviewReason({ ...base, gate: [{ ...gate[0]!, probability: 0.6 }] })).toMatch(/near miss/);
    expect(reviewReason({ ...base, gate: [{ ...gate[0]!, decision: 'yes', probability: 0.9 }] })).toBeNull();
  });

  it('samples the rest', () => {
    expect(reviewReason({ ...base, sampleRate: 0.1, rand: () => 0.05 })).toBe('sample');
    expect(reviewReason({ ...base, sampleRate: 0.1, rand: () => 0.5 })).toBeNull();
  });
});

const lines: Line[] = [
  { n: 1, ts: '1.1', userId: 'U1', isBot: false, name: 'Ann', text: 'what time is the event?', gate: { messageTs: '1.1', authorId: 'U1', decision: 'no', probability: 0.4 } },
  { n: 2, ts: '1.2', userId: 'U1', isBot: false, name: 'Ann', text: '@bot hello??' },
  { n: 3, ts: '1.3', userId: null, isBot: true, name: 'bot', text: 'It starts at 9.' },
  { n: 4, ts: '1.4', userId: 'U1', isBot: false, name: 'Ann', text: 'no, it says 10', gate: { messageTs: '1.4', authorId: 'U1', decision: 'yes', probability: 0.95 } },
];
const finding = (f: Partial<Finding>): Finding => ({ categories: ['incorrect_info'], summary: 'wrong time', evidence_lines: [3, 4], bot_line: 3, signal: 'correction', ...f });

describe('validateFindings', () => {
  it('keeps cited findings and resolves the bot line', () => {
    const [v] = validateFindings([finding({})], lines);
    expect(v!.categories).toEqual(['incorrect_info']);
    expect(v!.lines.map((l) => l.n)).toEqual([3, 4]);
    expect(v!.botLine?.n).toBe(3);
  });

  it('drops findings without real evidence', () => {
    expect(validateFindings([finding({ evidence_lines: [99], bot_line: null })], lines)).toEqual([]);
    expect(validateFindings([finding({ summary: '  ' })], lines)).toEqual([]);
  });

  it('adds the bot line to the evidence and ignores a bot_line that is a human message', () => {
    expect(validateFindings([finding({ evidence_lines: [4] })], lines)[0]!.lines.map((l) => l.n)).toEqual([4, 3]);
    expect(validateFindings([finding({ bot_line: 4 })], lines)[0]!.botLine).toBeNull();
  });

  it('needs a gate "no" among the evidence for gate_false_negative, a gate "yes" for gate_false_positive', () => {
    expect(validateFindings([finding({ categories: ['gate_false_negative'], evidence_lines: [1, 2], bot_line: null })], lines)[0]!.categories).toEqual(['gate_false_negative']);
    expect(validateFindings([finding({ categories: ['gate_false_negative'], evidence_lines: [2], bot_line: null })], lines)).toEqual([]);
    expect(validateFindings([finding({ categories: ['gate_false_positive', 'incomplete'], evidence_lines: [2] })], lines)[0]!.categories).toEqual(['incomplete']);
    expect(validateFindings([finding({ categories: ['gate_false_positive'], evidence_lines: [4], bot_line: null })], lines)[0]!.categories).toEqual(['gate_false_positive']);
  });

  it('keeps at most five', () => {
    expect(validateFindings(Array.from({ length: 8 }, () => finding({})), lines)).toHaveLength(5);
  });
});

describe('renderReviewTranscript', () => {
  it('numbers lines and marks gate decisions', () => {
    const out = renderReviewTranscript(lines);
    expect(out).toContain('[1] {gate: NOT answered, p=0.40} <@U1|Ann>: what time is the event?');
    expect(out).toContain('[3] [bot] bot: It starts at 9.');
    expect(out).toContain('[4] {gate: answer}');
  });
});
