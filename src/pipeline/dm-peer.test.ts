import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/redis.js', () => ({ redis: {} }));
vi.mock('../context/users.js', () => ({ getUserInfo: async () => null }));
const { isNonHumanPeer } = await import('./dm-peer.js');
const { isSlackbotUser } = await import('./rules.js');

describe('DM peers', () => {
  it('Slackbot, bot users and app users are not people', () => {
    expect(isSlackbotUser('USLACKBOT')).toBe(true);
    expect(isSlackbotUser('U123')).toBe(false);
    expect(isNonHumanPeer('USLACKBOT', null)).toBe(true);
    expect(isNonHumanPeer('U1', { isBot: true })).toBe(true);
    expect(isNonHumanPeer('U1', { isBot: false, isAppUser: true })).toBe(true);
    expect(isNonHumanPeer('U1', { isBot: false })).toBe(false);
    expect(isNonHumanPeer('U1', null)).toBe(false); // unknown: fail open
  });
});
