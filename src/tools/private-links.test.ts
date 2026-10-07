/** The private-link decision table (pure). Wiring into the read tools: private-links.int.test.ts. */
import './test-env.js';
import { afterAll, describe, expect, it } from 'vitest';
import { redis } from '../core/redis.js';
import { askInDmMessage, decidePrivateLink, notVisibleMessage, type PrivateLinkInput } from './private-links.js';

afterAll(() => redis.disconnect());

const SPEAKER = 'U0SPEAKER';
const PRIV = 'C0PRIV';
const base: PrivateLinkInput = {
  link: { id: PRIV, kind: 'private_channel', isMember: true },
  speakerIsMember: true,
  speakerId: SPEAKER,
  current: { id: 'D0SPEAKER', kind: 'dm', imUserId: SPEAKER },
};
const with_ = (o: Partial<PrivateLinkInput>): PrivateLinkInput => ({ ...base, ...o });

describe('decidePrivateLink', () => {
  it('allows a private channel both are in, asked in the speaker’s DM with the bot', () => {
    expect(decidePrivateLink(base)).toEqual({ ok: true, via: 'dm' });
  });

  it('allows it in the linked private channel itself', () => {
    expect(decidePrivateLink(with_({ current: { id: PRIV, kind: 'private_channel' } }))).toEqual({ ok: true, via: 'same_channel' });
    // even when the current conversation's info is unknown: the id match is enough
    expect(decidePrivateLink(with_({ current: { id: PRIV } }))).toEqual({ ok: true, via: 'same_channel' });
  });

  it.each<[string, Partial<PrivateLinkInput>, 'not_visible' | 'ask_in_dm']>([
    // (a) the bot can't see it / isn't in it
    ['channel unknown to the bot', { link: null }, 'not_visible'],
    ['bot not a member', { link: { id: PRIV, kind: 'private_channel', isMember: false } }, 'not_visible'],
    // (b) the speaker isn't in it: indistinguishable from (a)
    ['speaker not a member', { speakerIsMember: false }, 'not_visible'],
    ['speaker not a member, asked in the channel', { speakerIsMember: false, current: { id: PRIV, kind: 'private_channel' } }, 'not_visible'],
    ['neither a member', { link: { id: PRIV, kind: 'private_channel', isMember: false }, speakerIsMember: false }, 'not_visible'],
    // only private channels: DMs and group DMs are never read through a link
    ['link to a DM', { link: { id: 'D0OTHER', kind: 'dm', isMember: true } }, 'not_visible'],
    ['link to a group DM', { link: { id: 'C0MPIM', kind: 'group_dm', isMember: true } }, 'not_visible'],
    ['link to a group DM, asked in it', { link: { id: 'C0MPIM', kind: 'group_dm', isMember: true }, current: { id: 'C0MPIM', kind: 'group_dm' } }, 'not_visible'],
    ['public channel (handled by the public path)', { link: { id: 'C0PUB', kind: 'public_channel', isMember: true } }, 'not_visible'],
    // (c) both members, but asked somewhere others could see it
    ['asked in a public channel', { current: { id: 'C0PUB', kind: 'public_channel' } }, 'ask_in_dm'],
    ['asked in another private channel', { current: { id: 'C0OTHERPRIV', kind: 'private_channel' } }, 'ask_in_dm'],
    ['asked in a group DM', { current: { id: 'C0MPIM', kind: 'group_dm' } }, 'ask_in_dm'],
    ['asked in someone else’s DM', { current: { id: 'D0OTHER', kind: 'dm', imUserId: 'U0SOMEONE' } }, 'ask_in_dm'],
    ['DM whose other party is unknown', { current: { id: 'D0SPEAKER', kind: 'dm' } }, 'ask_in_dm'],
    ['current conversation unknown', { current: { id: 'D0SPEAKER' } }, 'ask_in_dm'],
  ])('refuses: %s', (_name, o, reason) => {
    expect(decidePrivateLink(with_(o))).toEqual({ ok: false, reason });
  });

  it('refusals name no channel and reveal nothing to non-members', () => {
    for (const what of ['thread', 'channel'] as const) {
      expect(notVisibleMessage(what)).toMatch(new RegExp(`^Can't read that ${what}`));
      expect(askInDmMessage(what)).toMatch(new RegExp(`^Can't read that ${what}`));
      for (const m of [notVisibleMessage(what), askInDmMessage(what)]) expect(m).not.toMatch(/<#|C0/);
    }
  });
});
