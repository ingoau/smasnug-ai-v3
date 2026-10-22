import { describe, expect, it, vi } from 'vitest';

const LIVE = process.env.LIVE === '1';
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

const { validateOps, isSensitive, renderTranscript, proposeOps } = await import('./extract.js');
const { parseFactId } = await import('./store.js');
import type { MemoryOp } from './extract.js';

const P = 'UALICE';
const base = {
  participantId: P,
  existing: [
    { id: 7, text: 'prefers Python' },
    { id: 8, text: 'is building a weather station' },
  ],
  participantMessages: ["Honestly I've switched to TypeScript for everything now", 'I finished the weather station last week!'],
  otherPeople: [{ id: 'USAM', name: 'Sam' }],
};
const op = (o: Partial<MemoryOp>): MemoryOp => ({ op: 'add', user_id: P, fact_id: null, text: null, kind: null, evidence: null, ...o });

describe('validateOps', () => {
  it('accepts a fact quoted from the participant', () => {
    const { accepted, rejected } = validateOps(
      [op({ text: 'prefers TypeScript', evidence: "I've switched to TypeScript for everything" })],
      base,
    );
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  it('rejects cross-user writes', () => {
    const { accepted, rejected } = validateOps(
      [
        op({ user_id: 'USAM', text: 'prefers TypeScript', evidence: "I've switched to TypeScript for everything" }),
        op({ op: 'remove', user_id: 'USAM', fact_id: 7 }),
      ],
      base,
    );
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['cross_user', 'cross_user']);
  });

  it("rejects update/remove of facts that aren't the participant's", () => {
    const { accepted, rejected } = validateOps(
      [op({ op: 'remove', fact_id: 999 }), op({ op: 'update', fact_id: null, text: 'x is y', evidence: 'switched to TypeScript' })],
      base,
    );
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['unknown_fact', 'unknown_fact']);
  });

  it('requires evidence from the participant’s own messages', () => {
    const { rejected } = validateOps(
      [
        op({ text: 'likes Rust', evidence: 'Alice loves Rust, she told me' }), // e.g. said by someone else
        op({ text: 'likes Go', evidence: null }),
      ],
      base,
    );
    expect(rejected.map((r) => r.reason)).toEqual(['evidence_not_from_participant', 'no_evidence']);
  });

  it('matches evidence despite whitespace, case and formatting', () => {
    const { accepted } = validateOps([op({ text: 'prefers TypeScript', evidence: "i've   *switched* to typescript" })], base);
    expect(accepted).toHaveLength(1);
  });

  it('filters sensitive categories and facts about others', () => {
    const msgs = { ...base, participantMessages: ['I was diagnosed with ADHD last year', 'Sam is my best friend and he is moving'] };
    const { rejected } = validateOps(
      [
        op({ text: 'has ADHD', evidence: 'diagnosed with ADHD last year' }),
        op({ text: "Sam's best friend is moving", evidence: 'Sam is my best friend' }),
        op({ text: 'works with <@USAM>', evidence: 'Sam is my best friend' }),
      ],
      msgs,
    );
    expect(rejected.map((r) => r.reason)).toEqual(['sensitive', 'about_others', 'about_others']);
  });

  it('updates and removes own facts, rejects duplicates and double-targeting', () => {
    const { accepted, rejected } = validateOps(
      [
        op({ op: 'update', fact_id: 7, text: 'prefers TypeScript', evidence: 'switched to TypeScript for everything' }),
        op({ op: 'remove', fact_id: 8, evidence: 'finished the weather station' }),
        op({ op: 'remove', fact_id: 8, evidence: 'finished the weather station' }),
        op({ text: 'Prefers  TypeScript.', evidence: 'switched to TypeScript for everything' }),
      ],
      base,
    );
    expect(accepted.map((a) => a.op)).toEqual(['update', 'remove']);
    expect(rejected.map((r) => r.reason)).toEqual(['unknown_fact', 'duplicate']);
  });

  it('removes only what the participant took back, or a duplicate of a fact that stays', () => {
    const existing = [
      { id: 7, text: 'prefers Python' },
      { id: 8, text: 'is building a weather station' },
      { id: 9, text: 'is building a weather station!' },
      { id: 10, text: 'lives in Sydney' },
    ];
    const { accepted, rejected } = validateOps(
      [
        op({ op: 'remove', fact_id: 10 }), // nothing said about it: no silent wipe
        op({ op: 'remove', fact_id: 7, evidence: 'something they never said' }),
        op({ op: 'remove', fact_id: 7, evidence: 'I finished the weather station' }), // their words, but not about this fact
        op({ op: 'remove', fact_id: 8 }), // duplicate of 9, which stays
        op({ op: 'remove', fact_id: 9 }), // no longer a duplicate once 8 is gone
      ],
      { ...base, existing },
    );
    expect(accepted.map((a) => a.fact_id)).toEqual([8]);
    expect(rejected.map((r) => [r.op.fact_id, r.reason])).toEqual([
      [10, 'no_evidence'],
      [7, 'no_evidence'],
      [7, 'no_evidence'],
      [9, 'no_evidence'],
    ]);
  });

  it('lets an update restate its own fact but not duplicate another, and tells negations and short words apart', () => {
    const existing = [
      { id: 7, text: 'prefers Python' },
      { id: 8, text: 'uses Go at work' },
      { id: 9, text: 'can use Docker' },
    ];
    const msgs = { ...base, existing, participantMessages: ["I prefer Python, I use C at work and I can't use Docker anymore"] };
    const { accepted, rejected } = validateOps(
      [
        op({ op: 'update', fact_id: 7, text: 'prefers python', evidence: 'I prefer Python' }),
        op({ text: 'uses C at work', evidence: 'I use C at work' }),
        op({ text: "can't use Docker", evidence: "can't use Docker anymore" }),
        op({ op: 'update', fact_id: 8, text: 'Prefers Python.', evidence: 'I prefer Python' }),
      ],
      msgs,
    );
    expect(accepted.map((a) => a.text)).toEqual(['prefers python', 'uses C at work', "can't use Docker"]);
    expect(rejected.map((r) => r.reason)).toEqual(['duplicate']);
  });

  it('accepts a removal with evidence about the fact, and only the lower id of two duplicates', () => {
    const existing = [
      { id: 8, text: 'is building a weather station' },
      { id: 9, text: 'is building a weather station!' },
      { id: 10, text: 'lives in Sydney' },
    ];
    const msgs = { ...base, existing, participantMessages: ['I finished the weather station last week!', "I don't live there anymore"] };
    const { accepted, rejected } = validateOps(
      [op({ op: 'remove', fact_id: 9 }), op({ op: 'remove', fact_id: 8, evidence: 'finished the weather station' }), op({ op: 'remove', fact_id: 10, evidence: "don't live there anymore" })],
      msgs,
    );
    expect(accepted.map((a) => a.fact_id)).toEqual([8, 10]);
    expect(rejected.map((r) => [r.op.fact_id, r.reason])).toEqual([[9, 'no_evidence']]);
  });

  it('rejects facts naming another participant by any part of their name', () => {
    const msgs = { ...base, participantMessages: ['Sam is handling venues with me'], otherPeople: [{ id: 'USAM', name: 'Sam Smith (he/him)' }] };
    const { rejected } = validateOps([op({ text: 'works on venues with Sam', evidence: 'Sam is handling venues' })], msgs);
    expect(rejected.map((r) => r.reason)).toEqual(['about_others']);
  });

  it('caps the number of ops per pass', () => {
    const msgs = { ...base, existing: [], participantMessages: [Array.from({ length: 15 }, (_, i) => `I like thing number ${i}`).join('. ')] };
    const ops = Array.from({ length: 15 }, (_, i) => op({ text: `likes thing ${i}`, evidence: `I like thing number ${i}` }));
    const { accepted, rejected } = validateOps(ops, msgs);
    expect(accepted).toHaveLength(10);
    expect(rejected.every((r) => r.reason === 'too_many')).toBe(true);
  });
});

describe('isSensitive', () => {
  it('flags obvious categories but not ordinary facts', () => {
    expect(isSensitive('is in therapy')).toBe(true);
    expect(isSensitive('parents are divorced')).toBe(true);
    expect(isSensitive('prefers short answers')).toBe(false);
    expect(isSensitive('is building a robot arm for Blueprint')).toBe(false);
  });
});

describe('parseFactId', () => {
  it('accepts m_42, [m_42], 42 and numbers', () => {
    expect(parseFactId('m_42')).toBe(42);
    expect(parseFactId('[m_42]')).toBe(42);
    expect(parseFactId('M42')).toBe(42);
    expect(parseFactId('42')).toBe(42);
    expect(parseFactId(42)).toBe(42);
    expect(parseFactId('w_42')).toBeNull();
    expect(parseFactId('42; drop table')).toBeNull();
    expect(parseFactId(-1)).toBeNull();
  });
});

describe.skipIf(!LIVE)('live extraction (LIVE=1)', () => {
  it('extracts only the participant’s own non-sensitive facts', async () => {
    const lines = [
      { userId: 'UALICE', isBot: false, name: 'Alice', text: "<@UBOT> can you help me pick a microcontroller? I'm building a plant watering robot for Blueprint. I mostly write Rust these days, please keep answers short." },
      { userId: null, isBot: true, name: 'Smasnug', text: 'Sure! For a plant waterer an ESP32-C3 is a good pick: cheap, Wi-Fi, and Rust support via esp-hal.' },
      { userId: 'USAM', isBot: false, name: 'Sam', text: "Alice also loves Python and she's been stressed about exams, haha" },
      { userId: 'UALICE', isBot: false, name: 'Alice', text: "lol no, not Python. Also I was diagnosed with asthma so I can't do the soldering in a closed room — ignore that. Thanks!" },
    ];
    const existing = [{ id: 3, text: 'prefers long, detailed answers' }];
    const ops = await proposeOps({ participant: { id: 'UALICE', name: 'Alice' }, transcript: renderTranscript(lines, 'UALICE'), existing });
    const { accepted, rejected } = validateOps(ops, {
      participantId: 'UALICE',
      existing,
      participantMessages: lines.filter((l) => l.userId === 'UALICE').map((l) => l.text),
      otherPeople: [{ id: 'USAM', name: 'Sam' }],
    });
    console.log(JSON.stringify({ ops, accepted, rejected: rejected.map((r) => [r.reason, r.op.text]) }, null, 2));
    const texts = accepted.map((a) => (a.text ?? '').toLowerCase()).join(' | ');
    expect(accepted.length).toBeGreaterThan(0);
    // Sam's claims about Alice and sensitive details must not be stored. Alice's own "not Python" may be.
    expect(texts).not.toMatch(/exam|stress|asthma/);
    expect(texts).not.toMatch(/(loves|likes|into|enjoys|prefers) python/);
    expect(accepted.every((a) => a.user_id === 'UALICE')).toBe(true);
  }, 60_000);
});
