import { describe, expect, it } from 'vitest';
import {
  answersOtherOffer,
  awaitsReply,
  batchIsAddressed,
  batchIsPartnerLike,
  batchIsRecentPartner,
  batchIsMention,
  batchNeedsGate,
  debounceWindowMs,
  decide,
  gateThreshold,
  isCooling,
  isRecentPartner,
  lastEngagedAt,
  mentionFacts,
  shouldDisengage,
  threadRootTs,
  type MessageFacts,
} from './rules.js';

const base: MessageFacts = {
  isBot: false,
  isDm: false,
  mentionsBot: false,
  mentionsOthers: false,
  engaged: true,
  disengageDue: false,
  twoParty: false,
};

describe('decide', () => {
  it('never runs for bots, even when they mention the bot or post in a DM', () => {
    expect(decide({ ...base, isBot: true, mentionsBot: true, isDm: true })).toEqual({ action: 'ignore', reason: 'bot' });
  });
  it('always runs on DMs and mentions', () => {
    expect(decide({ ...base, isDm: true, engaged: false })).toEqual({ action: 'batch', reason: 'dm' });
    expect(decide({ ...base, mentionsBot: true, engaged: false, mentionsOthers: true })).toEqual({ action: 'batch', reason: 'mention' });
  });
  it('ignores follow-ups in threads that are not engaged', () => {
    expect(decide({ ...base, engaged: false })).toEqual({ action: 'ignore', reason: 'not_engaged' });
  });
  it('skips messages that mention someone else and not the bot', () => {
    expect(decide({ ...base, mentionsOthers: true, twoParty: true })).toEqual({ action: 'ignore', reason: 'mentions_other' });
  });
  it('ignores once disengagement is due', () => {
    expect(decide({ ...base, disengageDue: true, twoParty: true })).toEqual({ action: 'ignore', reason: 'disengaged' });
  });
  it('two-party threads and the bot\'s conversation partner go through the gate as partners; everything else is gated', () => {
    expect(decide({ ...base, twoParty: true })).toEqual({ action: 'batch', reason: 'partner' });
    expect(decide({ ...base, partner: true })).toEqual({ action: 'batch', reason: 'partner' });
    expect(decide(base)).toEqual({ action: 'batch', reason: 'gate' });
  });
  it('an answer to the bot\'s question runs without the gate, even disengaged or idle, unless it mentions someone else', () => {
    expect(decide({ ...base, awaitedReply: true })).toEqual({ action: 'batch', reason: 'direct' });
    expect(decide({ ...base, awaitedReply: true, engaged: false })).toEqual({ action: 'batch', reason: 'direct' });
    expect(decide({ ...base, awaitedReply: true, disengageDue: true })).toEqual({ action: 'batch', reason: 'direct' });
    expect(decide({ ...base, awaitedReply: true, mentionsOthers: true })).toEqual({ action: 'ignore', reason: 'mentions_other' });
    expect(decide({ ...base, awaitedReply: true, quietPrefix: true })).toEqual({ action: 'ignore', reason: 'quiet' });
  });
});

describe("someone else answering the bot's question / offer", () => {
  it('is the first human message after a reply that awaited someone else', () => {
    expect(answersOtherOffer({ awaitsReplyFrom: 'U1', authorId: 'U2', humansSinceReply: false })).toBe(true);
    expect(answersOtherOffer({ awaitsReplyFrom: 'U1', authorId: 'U2', humansSinceReply: true })).toBe(false);
    expect(answersOtherOffer({ awaitsReplyFrom: 'U1', authorId: 'U1', humansSinceReply: false })).toBe(false); // that's 'direct'
    expect(answersOtherOffer({ awaitsReplyFrom: null, authorId: 'U2', humansSinceReply: false })).toBe(false);
  });
  it('goes through the gate (partner threshold) in an engaged thread, never skipping it', () => {
    expect(decide({ ...base, answersOther: true })).toEqual({ action: 'batch', reason: 'answer_other' });
    expect(decide({ ...base, answersOther: true, engaged: false })).toEqual({ action: 'ignore', reason: 'not_engaged' });
    expect(decide({ ...base, answersOther: true, disengageDue: true })).toEqual({ action: 'ignore', reason: 'disengaged' });
    expect(decide({ ...base, answersOther: true, mentionsOthers: true })).toEqual({ action: 'ignore', reason: 'mentions_other' });
    expect(decide({ ...base, answersOther: true, awaitedReply: true })).toEqual({ action: 'batch', reason: 'direct' });
    expect(batchNeedsGate(['answer_other'])).toBe(true);
    expect(batchIsAddressed(['answer_other'])).toBe(true);
    expect(batchIsPartnerLike(['answer_other', 'gate'])).toBe(true);
    expect(batchIsPartnerLike(['partner'])).toBe(true);
    expect(batchIsPartnerLike(['gate'])).toBe(false);
    expect(debounceWindowMs(false, { idleMs: 1000, busyMs: 3000, directMs: 300 }, 'answer_other')).toBe(300);
  });
});

describe("the bot's recent partner after someone else wrote", () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const tenMin = 10 * 60_000;
  const f = { authorId: 'U1', lastBotPartner: 'U1', lastBotReplyAt: ago(4 * 60_000), othersSpoke: true };
  it('is the latest partner within the window, only when someone else wrote since the reply', () => {
    expect(isRecentPartner(f, now, tenMin)).toBe(true);
    expect(isRecentPartner({ ...f, lastBotReplyAt: ago(tenMin) }, now, tenMin)).toBe(true);
    expect(isRecentPartner({ ...f, lastBotReplyAt: ago(tenMin + 1) }, now, tenMin)).toBe(false);
    expect(isRecentPartner({ ...f, othersSpoke: false }, now, tenMin)).toBe(false); // that's a plain 'partner'
    expect(isRecentPartner({ ...f, lastBotPartner: 'U2' }, now, tenMin)).toBe(false);
    expect(isRecentPartner({ ...f, lastBotPartner: null }, now, tenMin)).toBe(false);
    expect(isRecentPartner({ ...f, lastBotReplyAt: null }, now, tenMin)).toBe(false);
    expect(isRecentPartner({ ...f, lastBotReplyAt: new Date(now.getTime() + 1000) }, now, tenMin)).toBe(false);
  });
  it('goes through the gate (not addressed) unless a stronger reason applies', () => {
    expect(decide({ ...base, recentPartner: true })).toEqual({ action: 'batch', reason: 'recent_partner' });
    expect(decide({ ...base, recentPartner: true, partner: true })).toEqual({ action: 'batch', reason: 'partner' });
    expect(decide({ ...base, recentPartner: true, answersOther: true })).toEqual({ action: 'batch', reason: 'answer_other' });
    expect(decide({ ...base, recentPartner: true, mentionsOthers: true })).toEqual({ action: 'ignore', reason: 'mentions_other' });
    expect(decide({ ...base, recentPartner: true, engaged: false })).toEqual({ action: 'ignore', reason: 'not_engaged' });
    expect(decide({ ...base, recentPartner: true, quietPrefix: true })).toEqual({ action: 'ignore', reason: 'quiet' });
    expect(batchNeedsGate(['recent_partner', 'gate'])).toBe(true);
    expect(batchIsAddressed(['recent_partner'])).toBe(false);
    expect(batchIsPartnerLike(['recent_partner'])).toBe(false);
    expect(batchIsRecentPartner(['recent_partner', 'gate'])).toBe(true);
    expect(batchIsRecentPartner(['recent_partner', 'partner'])).toBe(false); // partner wins
    expect(batchIsRecentPartner(['gate'])).toBe(false);
  });
});

describe('batch helpers', () => {
  it('needs the gate only when every message was gated (partner messages are gated too)', () => {
    expect(batchNeedsGate(['gate', 'gate'])).toBe(true);
    expect(batchNeedsGate(['gate', 'partner'])).toBe(true);
    expect(batchNeedsGate(['gate', 'direct'])).toBe(false);
    expect(batchNeedsGate(['partner', 'mention'])).toBe(false);
    expect(batchNeedsGate([])).toBe(false);
  });
  it('is addressed (talking with the bot) for answers to the bot and partner follow-ups', () => {
    expect(batchIsAddressed(['direct'])).toBe(true);
    expect(batchIsAddressed(['gate', 'partner'])).toBe(true);
    expect(batchIsAddressed(['gate'])).toBe(false);
  });
  it('is a mention batch when any message was a mention/DM/stop-mention', () => {
    expect(batchIsMention(['gate', 'mention'])).toBe(true);
    expect(batchIsMention(['dm'])).toBe(true);
    expect(batchIsMention(['direct', 'gate'])).toBe(false);
  });
});

describe('gate threshold and idle clock', () => {
  const t = { base: 0.8, partner: 0.65, cooling: 0.9 };
  const now = new Date('2026-10-03T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it('partner < base < cooling; a partner keeps the low threshold even when the thread cooled', () => {
    expect(gateThreshold({ partner: false, cooling: false }, t)).toBe(0.8);
    expect(gateThreshold({ partner: true, cooling: false }, t)).toBe(0.65);
    expect(gateThreshold({ partner: false, cooling: true }, t)).toBe(0.9);
    expect(gateThreshold({ partner: true, cooling: true }, t)).toBe(0.65);
  });
  it('a recent partner after someone else wrote gets the intermediate threshold; partner wins over it', () => {
    const t2 = { ...t, partner: 0.6, recentPartner: 0.7 };
    expect(gateThreshold({ partner: false, recentPartner: true, cooling: false }, t2)).toBe(0.7);
    expect(gateThreshold({ partner: false, recentPartner: true, cooling: true }, t2)).toBe(0.7);
    expect(gateThreshold({ partner: true, recentPartner: true, cooling: false }, t2)).toBe(0.6);
    expect(gateThreshold({ partner: false, recentPartner: false, cooling: false }, t2)).toBe(0.8);
    expect(gateThreshold({ partner: false, recentPartner: true, cooling: false }, t)).toBe(0.8); // not configured
  });
  it('any bot reply counts as activity: the idle clock runs from the later of address and reply', () => {
    expect(lastEngagedAt({ lastAddressedAt: null, lastBotReplyAt: null })).toBeNull();
    expect(lastEngagedAt({ lastAddressedAt: ago(5000), lastBotReplyAt: ago(1000) })).toEqual(ago(1000));
    expect(lastEngagedAt({ lastAddressedAt: ago(1000), lastBotReplyAt: null })).toEqual(ago(1000));
    const h3 = 3 * 3600_000;
    expect(isCooling({ lastAddressedAt: ago(h3 + 1), lastBotReplyAt: null }, now, h3)).toBe(true);
    expect(isCooling({ lastAddressedAt: ago(h3 + 1), lastBotReplyAt: ago(60_000) }, now, h3)).toBe(false);
    expect(isCooling({ lastAddressedAt: null, lastBotReplyAt: null }, now, h3)).toBe(false);
  });
});

describe('awaitsReply', () => {
  it('questions, offers and buttons wait for an answer; statements do not', () => {
    expect(awaitsReply('want me to dig deeper?')).toBe(true);
    expect(awaitsReply('which one, the pico or the esp32? :eyes:')).toBe(true);
    expect(awaitsReply('ok, does that work?)')).toBe(true);
    expect(awaitsReply('here it is. i can build the whole thing if you want')).toBe(true);
    expect(awaitsReply('found 3 options. want me to compare them.')).toBe(true);
    expect(awaitsReply('pick one', true)).toBe(true);
    expect(awaitsReply('the deadline is friday.')).toBe(false);
    expect(awaitsReply('is it friday? yes, friday at 5pm.')).toBe(false);
    expect(awaitsReply('')).toBe(false);
  });
});

describe('shouldDisengage', () => {
  const opts = { afterMessages: 25, afterMs: 3 * 3600_000 };
  const now = new Date('2026-10-03T12:00:00Z');
  it('after more than N messages without being addressed', () => {
    expect(shouldDisengage({ messagesSinceAddressed: 25, lastAddressedAt: now }, now, opts)).toBe(false);
    expect(shouldDisengage({ messagesSinceAddressed: 26, lastAddressedAt: now }, now, opts)).toBe(true);
  });
  it('after the time window', () => {
    const t = new Date(now.getTime() - 3 * 3600_000 - 1);
    expect(shouldDisengage({ messagesSinceAddressed: 1, lastAddressedAt: t }, now, opts)).toBe(true);
    expect(shouldDisengage({ messagesSinceAddressed: 1, lastAddressedAt: new Date(now.getTime() - 3600_000) }, now, opts)).toBe(false);
    expect(shouldDisengage({ messagesSinceAddressed: 1, lastAddressedAt: null }, now, opts)).toBe(false);
    // A recent bot reply (e.g. a synthesis turn) keeps the thread alive.
    expect(shouldDisengage({ messagesSinceAddressed: 1, lastAddressedAt: t, lastBotReplyAt: new Date(now.getTime() - 60_000) }, now, opts)).toBe(false);
  });
});

describe('mentionFacts', () => {
  it('detects the bot and others', () => {
    expect(mentionFacts('hey <@UBOT> look', 'UBOT')).toEqual({ mentionsBot: true, mentionsOthers: false });
    expect(mentionFacts('<@U123|bob> and <@UBOT>', 'UBOT')).toEqual({ mentionsBot: true, mentionsOthers: true });
    expect(mentionFacts('<@W999> thoughts?', 'UBOT')).toEqual({ mentionsBot: false, mentionsOthers: true });
    expect(mentionFacts('<!here> anyone?', 'UBOT')).toEqual({ mentionsBot: false, mentionsOthers: true });
    expect(mentionFacts('no mentions', 'UBOT')).toEqual({ mentionsBot: false, mentionsOthers: false });
  });
});


describe('debounceWindowMs', () => {
  it('scales with active runs', () => {
    expect(debounceWindowMs(false, { idleMs: 1000, busyMs: 3000 })).toBe(1000);
    expect(debounceWindowMs(true, { idleMs: 1000, busyMs: 3000 })).toBe(3000);
    const opts = { idleMs: 1000, busyMs: 3000, directMs: 300 };
    expect(debounceWindowMs(false, opts, 'dm')).toBe(300);
    expect(debounceWindowMs(false, opts, 'mention')).toBe(300);
    expect(debounceWindowMs(false, opts, 'gate')).toBe(1000);
    expect(debounceWindowMs(false, opts, 'partner')).toBe(300);
    expect(debounceWindowMs(false, opts, 'direct')).toBe(300);
    expect(debounceWindowMs(true, opts, 'dm')).toBe(3000);
  });
});

describe('threadRootTs', () => {
  it('uses thread_ts when present, else ts', () => {
    expect(threadRootTs({ ts: '2.0', thread_ts: '1.0' })).toBe('1.0');
    expect(threadRootTs({ ts: '2.0' })).toBe('2.0');
  });
});
