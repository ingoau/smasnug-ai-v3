import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (process.env.LIVE === '1') {
    try {
      process.loadEnvFile('.env');
    } catch {}
  }
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../../db/index.js', () => ({ sql: {} }));
vi.mock('../../core/redis.js', () => ({ redis: {} }));
vi.mock('../guard.js', () => ({ recordModelUsage: async () => {} }));

const { validatePruneOps } = await import('./prune.js');
import type { PruneFact, PruneOp } from './prune.js';

const d = new Date('2026-10-01T00:00:00Z');
const facts: PruneFact[] = [
  { id: 5, text: 'is making improvements to smasnug AI', kind: 'about', statedAt: d },
  { id: 14, text: 'is optimizing smasnug AI for faster initial responses', kind: 'project', statedAt: d },
  { id: 31, text: 'is adding cheese-swapped caption emojis to the workspace', kind: 'project', statedAt: d },
  { id: 41, text: 'prefers generated emoji to be sent for review before upload', kind: 'preference', statedAt: d },
  { id: 50, text: 'prefers short answers', kind: 'preference', statedAt: d },
  { id: 51, text: 'likes concise replies', kind: 'preference', statedAt: d },
];
const op = (o: Partial<PruneOp>): PruneOp => ({ op: 'remove', fact_id: 0, merge_ids: null, text: null, reason: 'x', ...o });

describe('validatePruneOps', () => {
  it('removes task-only facts but never a preference on its own', () => {
    const { accepted, rejected } = validatePruneOps([op({ fact_id: 31 }), op({ fact_id: 41 })], facts);
    expect(accepted.map((a) => a.fact_id)).toEqual([31]);
    expect(rejected.map((r) => r.reason)).toEqual(['preference']);
  });

  it('merges using only words of the merged facts', () => {
    const ok = validatePruneOps([op({ op: 'merge', fact_id: 5, merge_ids: [14], text: 'is making smasnug AI faster' })], facts);
    // "faster" is in m_14, "making" in m_5.
    expect(ok.accepted).toHaveLength(1);
    const bad = validatePruneOps([op({ op: 'merge', fact_id: 5, merge_ids: [14], text: 'is the lead developer of smasnug AI' })], facts);
    expect(bad.rejected.map((r) => r.reason)).toEqual(['new_words']);
    const negated = validatePruneOps([op({ op: 'merge', fact_id: 50, merge_ids: [51], text: 'does not like short answers' })], facts);
    expect(negated.rejected.map((r) => r.reason)).toEqual(['new_words']);
  });

  it('merges preferences only with preferences', () => {
    const { rejected } = validatePruneOps([op({ op: 'merge', fact_id: 14, merge_ids: [41], text: 'is optimizing smasnug AI' })], facts);
    expect(rejected.map((r) => r.reason)).toEqual(['preference']);
    const ok = validatePruneOps([op({ op: 'merge', fact_id: 50, merge_ids: [51], text: 'prefers short concise answers' })], facts);
    expect(ok.accepted).toHaveLength(1);
  });

  it('rejects unknown, repeated and self-only targets', () => {
    const { accepted, rejected } = validatePruneOps(
      [op({ fact_id: 999 }), op({ fact_id: 31 }), op({ fact_id: 31 }), op({ op: 'merge', fact_id: 5, merge_ids: [5], text: 'x' })],
      facts,
    );
    expect(accepted.map((a) => a.fact_id)).toEqual([31]);
    expect(rejected.map((r) => r.reason)).toEqual(['unknown_fact', 'unknown_fact', 'unknown_fact']);
  });

  it('removes at most half the facts in one pass', () => {
    const many: PruneFact[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, text: `did one-off task number ${i}`, kind: 'project' as const, statedAt: d }));
    const { accepted, rejected } = validatePruneOps(many.map((f) => op({ fact_id: f.id })), many);
    expect(accepted).toHaveLength(3);
    expect(rejected.every((r) => r.reason === 'too_many')).toBe(true);
  });
});
