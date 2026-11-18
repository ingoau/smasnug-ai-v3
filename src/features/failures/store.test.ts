import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../../db/index.js', () => ({ sql: {} }));
import { mergeFailure, sameIncident, type NewFailure, type StoredFailure } from './store.js';

const stored = (o: Partial<StoredFailure> = {}): StoredFailure => ({
  turnId: 7,
  source: 'self',
  categories: ['incorrect_info'],
  summary: 'said 9, it is 10',
  signal: 'correction',
  evidence: [{ ts: '1.3', userId: 'U1', quote: 'no, 10' }],
  speakerId: 'U1',
  reviewVerdict: null,
  ...o,
});
const incoming = (o: Partial<NewFailure> = {}): NewFailure => ({
  threadId: 'T',
  channelId: 'C',
  turnId: 8,
  source: 'review',
  categories: ['incomplete'],
  summary: 'repeated the recommendation',
  signal: 'hindsight',
  evidence: [{ ts: '1.2', userId: 'UBOT', quote: 'x' }],
  speakerId: 'U2',
  idempotencyKey: 'k',
  ...o,
});

describe('sameIncident', () => {
  it('matches the same turn or an evidence message in common', () => {
    expect(sameIncident(stored(), incoming({ turnId: 7 }))).toBe(true);
    expect(sameIncident(stored(), incoming())).toBe(false);
    expect(sameIncident(stored(), incoming({ evidence: [{ ts: '1.3', userId: 'U1', quote: '' }] }))).toBe(true);
    expect(sameIncident(stored({ turnId: null }), incoming({ turnId: null }))).toBe(false);
  });
});

describe('mergeFailure', () => {
  it('unions categories and evidence, keeps the stronger signal with its summary, and confirms a self report the review found', () => {
    const m = mergeFailure(stored(), incoming());
    expect(m.categories).toEqual(['incorrect_info', 'incomplete']);
    expect(m.evidence.map((e) => e.ts)).toEqual(['1.2', '1.3']);
    expect(m).toMatchObject({ signal: 'correction', summary: 'said 9, it is 10', turnId: 7, speakerId: 'U1', source: 'self', reviewVerdict: 'confirmed' });
    const s = mergeFailure(stored({ source: 'review', signal: 'hindsight' }), incoming({ source: 'self', signal: 'explicit_complaint', summary: 'they said it was wrong' }));
    expect(s).toMatchObject({ source: 'self', reviewVerdict: 'confirmed', signal: 'explicit_complaint', summary: 'they said it was wrong' });
  });

  it('leaves the verdict alone between two reports of one source, and fills a missing turn', () => {
    expect(mergeFailure(stored({ source: 'review', turnId: null }), incoming())).toMatchObject({ source: 'review', reviewVerdict: null, turnId: 8 });
  });

  it('caps categories and evidence, keeping the existing ones', () => {
    const m = mergeFailure(
      stored({ categories: ['incorrect_info', 'incomplete', 'missed_context'], evidence: ['1', '2', '3'].map((ts) => ({ ts, userId: null, quote: '' })) }),
      incoming({ categories: ['too_slow'], evidence: ['0.5', '4'].map((ts) => ({ ts, userId: null, quote: '' })) }),
    );
    expect(m.categories).toEqual(['incorrect_info', 'incomplete', 'missed_context']);
    expect(m.evidence.map((e) => e.ts)).toEqual(['0.5', '1', '2', '3']);
  });
});
