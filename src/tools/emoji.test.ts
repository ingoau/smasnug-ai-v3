import { describe, expect, it, vi } from 'vitest';
import { formatNameMatches, looksLikeNameQuery, matchEmojiNames, namePatterns, semojiSearchRetry, type EmojiHit } from './emoji.js';

const list = {
  'yay-1': 'https://emoji.slack-edge.com/T/yay-1/a.png',
  'yay-party': 'https://emoji.slack-edge.com/T/yay-party/a.gif',
  yay: 'alias:yay-1',
  partyparrot: 'https://emoji.slack-edge.com/T/partyparrot/a.gif',
  'cat-wave': 'https://emoji.slack-edge.com/T/cat-wave/a.png',
};

describe('emoji name mode', () => {
  it('parses names and patterns: colons optional, lowercased, junk and bare * dropped', () => {
    expect(namePatterns(':Yay-*:, partyparrot  *  <script>')).toEqual(['yay-*', 'partyparrot']);
  });

  it('switches to names for a wildcard or :name:, not for a description', () => {
    expect(looksLikeNameQuery('yay-*')).toBe(true);
    expect(looksLikeNameQuery(':partyparrot:')).toBe(true);
    expect(looksLikeNameQuery('cat waving')).toBe(false);
  });

  it('matches globs and exact names, exact first, aliases marked', () => {
    expect(matchEmojiNames(list, ['yay-*'])).toEqual({ names: [{ name: 'yay-1' }, { name: 'yay-party' }], total: 2 });
    expect(matchEmojiNames(list, ['yay*']).names[0]).toEqual({ name: 'yay', aliasOf: 'yay-1' });
    expect(matchEmojiNames(list, ['*party*', 'yay']).names.map((n) => n.name)).toEqual(['yay', 'partyparrot', 'yay-party']);
    expect(matchEmojiNames(list, ['yay-*'], 1)).toEqual({ names: [{ name: 'yay-1' }], total: 2 });
    // Regex characters in a pattern are literal.
    expect(matchEmojiNames(list, ['yay.1']).total).toBe(0);
  });

  it('formats matches, the overflow and a miss', () => {
    expect(formatNameMatches(['yay-*'], matchEmojiNames(list, ['yay-*'], 1))).toBe('2 custom emoji match yay-*:\n:yay-1:\n…and 1 more; narrow the pattern.');
    expect(formatNameMatches(['nope'], matchEmojiNames(list, ['nope']))).toMatch(/^No custom emoji named "nope"/);
  });
});

describe('semojiSearchRetry', () => {
  const opts = { baseUrl: 'https://semoji.example' };
  const hit: EmojiHit[] = [{ name: 'tada', summary: 'party' }];

  it('retries once after a failure', async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error('The operation was aborted due to timeout')).mockResolvedValueOnce(hit);
    await expect(semojiSearchRetry('party', opts, search)).resolves.toEqual(hit);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second failure, and never retries a 4xx', async () => {
    const twice = vi.fn().mockRejectedValue(new Error('semoji HTTP 503'));
    await expect(semojiSearchRetry('party', opts, twice)).rejects.toThrow('503');
    expect(twice).toHaveBeenCalledTimes(2);
    const bad = vi.fn().mockRejectedValue(new Error('semoji HTTP 401'));
    await expect(semojiSearchRetry('party', opts, bad)).rejects.toThrow('401');
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
