import { describe, expect, it } from 'vitest';
import { formatRules, isNoPingPreference } from './rules.js';

describe('turn rules', () => {
  it('recognises "don\'t ping me" preferences, not other ones', () => {
    for (const t of ["doesn't want to be pinged", 'prefers not to be @mentioned', 'asked never to be tagged in threads', "don't ping them", 'wants replies without pinging them'])
      expect(isNoPingPreference(t), t).toBe(true);
    for (const t of ['wants to be pinged when a run finishes, not before', 'prefers short answers', 'likes being mentioned in updates', 'not a fan of emoji'])
      expect(isNoPingPreference(t), t).toBe(false);
  });

  it('formats channel rules and the no-ping list; empty when there is nothing', () => {
    expect(formatRules({ channelRules: [], noPing: [] })).toBe('');
    const s = formatRules({ channelRules: [{ text: 'reminder requests get only a ✅ reaction' }], noPing: ['U1', 'U2'] });
    expect(s).toContain('- reminder requests get only a ✅ reaction');
    expect(s).toContain('Asked not to be @mentioned (write their plain name instead): <@U1>, <@U2>');
  });
});
