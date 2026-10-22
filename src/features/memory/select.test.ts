import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});
vi.mock('../../db/index.js', () => ({ sql: {} }));
vi.mock('../../core/redis.js', () => ({ redis: {} }));

const { contentWords, factSimilarity, findDuplicate, orTsQuery } = await import('./store.js');
const { factAge, formatSpeakerMemory, selectFacts } = await import('./render.js');
import type { FactKind, RankedFact } from './store.js';

const DAY = 86_400_000;
const now = new Date('2026-10-22T00:00:00Z');
const fact = (id: number, text: string, kind: FactKind = 'about', rank = 0, daysAgo = 1): RankedFact => ({
  id,
  text,
  kind,
  rank,
  statedAt: new Date(now.getTime() - daysAgo * DAY),
});

describe('text helpers', () => {
  it('extracts content words without stopwords, mentions or punctuation', () => {
    expect(contentWords("Hey <@U123ABC>, I'm building robot arms with ROS2!")).toEqual(['hey', 'building', 'robot', 'arms', 'ros2']);
  });

  it('scores near-duplicates high and different facts low', () => {
    expect(factSimilarity('prefers TypeScript over Python', 'Prefers typescript over python.')).toBe(1);
    expect(factSimilarity('is building a robot arm', 'is building robot arms for Blueprint')).toBeGreaterThanOrEqual(0.5);
    expect(factSimilarity('prefers TypeScript', 'lives in Sydney')).toBe(0);
    expect(findDuplicate('prefers typescript over python', [{ id: 1, text: 'lives in Sydney' }, { id: 2, text: 'prefers TypeScript over Python' }])?.id).toBe(2);
    expect(findDuplicate('prefers Rust over Python', [{ id: 2, text: 'prefers TypeScript over Python' }])).toBeUndefined();
    // Short words, negations and word order count.
    expect(factSimilarity('uses Go', 'uses C')).toBeLessThan(0.75);
    expect(factSimilarity('is a morning person', 'is not a morning person')).toBeLessThan(0.75);
    expect(factSimilarity("can use Docker", "can't use Docker")).toBeLessThan(0.75);
    expect(factSimilarity('prefers TypeScript over Python', 'prefers Python over TypeScript')).toBeLessThan(0.75);
    expect(factSimilarity('works on the status page', 'works on the status pages')).toBe(1);
  });

  it('builds a safe OR tsquery', () => {
    expect(orTsQuery(["what's up with my robot arm?", 'robot & !arm | servo:*'])).toBe('robot | arm | servo');
    expect(orTsQuery(['the and for'])).toBe('');
    expect(orTsQuery(['café in München, 東京'])).toBe('café | münchen | 東京');
  });
});

describe('selectFacts', () => {
  it('puts relevant facts first, then preferences, then about before project', () => {
    const facts = [
      fact(1, 'is building a weather station', 'project'),
      fact(2, 'prefers short answers', 'preference'),
      fact(3, 'lives in Sydney', 'about'),
      fact(4, 'is building a robot arm', 'project', 0.3),
    ];
    expect(selectFacts(facts, 3).map((f) => f.id)).toEqual([4, 2, 3]);
  });

  it('does not let recently injected facts crowd out the rest (no last_used ordering)', () => {
    const many = Array.from({ length: 30 }, (_, i) => fact(i + 1, `knows tool number ${i + 1}`, 'about', 0, 100 - i));
    const relevant = fact(99, 'is learning Haskell', 'about', 0.1, 400);
    expect(selectFacts([...many, relevant], 20).map((f) => f.id)).toContain(99);
  });

  it('respects the cap and the character budget', () => {
    const facts = Array.from({ length: 30 }, (_, i) => fact(i + 1, 'x'.repeat(250)));
    expect(selectFacts(facts, 20)).toHaveLength(14); // 3600 / 250
    expect(selectFacts(facts, 5)).toHaveLength(5);
  });
});

describe('formatSpeakerMemory', () => {
  it('groups by kind, shows age for old facts and the hidden count', () => {
    const text = formatSpeakerMemory('UA', [fact(3, 'is building a robot arm', 'project', 0, 120), fact(2, 'prefers short answers', 'preference')], { total: 5, now });
    expect(text).toContain('How they like to be helped:\n- [m_2] prefers short answers\n');
    expect(text).toContain('- [m_3] is building a robot arm (4 mo ago)');
    expect(text.indexOf('m_2')).toBeLessThan(text.indexOf('m_3'));
    expect(text).toContain('3 more not shown: search_memory');
  });

  it('formats ages', () => {
    expect(factAge(new Date(now.getTime() - 5 * DAY), now)).toBe('');
    expect(factAge(new Date(now.getTime() - 65 * DAY), now)).toBe('2 mo ago');
    expect(factAge(new Date(now.getTime() - 800 * DAY), now)).toBe('2 y ago');
  });
});
