import { describe, expect, it } from 'vitest';
import {
  batchIsMention,
  batchNeedsGate,
  debounceWindowMs,
  decide,
  isStopMessage,
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
  isStop: false,
};

describe('decide', () => {
  it('never runs for bots, even when they mention the bot or post in a DM', () => {
    expect(decide({ ...base, isBot: true, mentionsBot: true, isDm: true })).toEqual({ action: 'ignore', reason: 'bot' });
  });
  it('always runs on DMs and mentions', () => {
    expect(decide({ ...base, isDm: true, engaged: false })).toEqual({ action: 'batch', reason: 'dm' });
    expect(decide({ ...base, mentionsBot: true, engaged: false, mentionsOthers: true })).toEqual({ action: 'batch', reason: 'mention' });
  });
  it('mention + stop disengages but is still delivered', () => {
    expect(decide({ ...base, mentionsBot: true, isStop: true })).toEqual({ action: 'batch', reason: 'stop', disengage: true });
  });
  it('ignores follow-ups in threads that are not engaged', () => {
    expect(decide({ ...base, engaged: false })).toEqual({ action: 'ignore', reason: 'not_engaged' });
    expect(decide({ ...base, engaged: false, isStop: true })).toEqual({ action: 'ignore', reason: 'not_engaged' });
  });
  it('skips messages that mention someone else and not the bot', () => {
    expect(decide({ ...base, mentionsOthers: true, twoParty: true })).toEqual({ action: 'ignore', reason: 'mentions_other' });
  });
  it('stop in an engaged thread disengages and is delivered, unless aimed at someone else', () => {
    expect(decide({ ...base, isStop: true })).toEqual({ action: 'batch', reason: 'stop', disengage: true });
    expect(decide({ ...base, isStop: true, mentionsOthers: true })).toEqual({ action: 'ignore', reason: 'mentions_other' });
  });
  it('ignores once disengagement is due', () => {
    expect(decide({ ...base, disengageDue: true, twoParty: true })).toEqual({ action: 'ignore', reason: 'disengaged' });
  });
  it('two-party threads skip the gate; everything else is gated', () => {
    expect(decide({ ...base, twoParty: true })).toEqual({ action: 'batch', reason: 'direct' });
    expect(decide(base)).toEqual({ action: 'batch', reason: 'gate' });
  });
});

describe('batch helpers', () => {
  it('needs the gate only when every message was gated', () => {
    expect(batchNeedsGate(['gate', 'gate'])).toBe(true);
    expect(batchNeedsGate(['gate', 'direct'])).toBe(false);
    expect(batchNeedsGate([])).toBe(false);
  });
  it('is a mention batch when any message was a mention/DM/stop-mention', () => {
    expect(batchIsMention(['gate', 'mention'])).toBe(true);
    expect(batchIsMention(['dm'])).toBe(true);
    expect(batchIsMention(['direct', 'gate'])).toBe(false);
  });
});

describe('shouldDisengage', () => {
  const opts = { afterMessages: 10, afterMs: 3 * 3600_000 };
  const now = new Date('2026-10-03T12:00:00Z');
  it('after more than N messages without being addressed', () => {
    expect(shouldDisengage({ messagesSinceAddressed: 10, lastAddressedAt: now }, now, opts)).toBe(false);
    expect(shouldDisengage({ messagesSinceAddressed: 11, lastAddressedAt: now }, now, opts)).toBe(true);
  });
  it('after the time window', () => {
    const t = new Date(now.getTime() - 3 * 3600_000 - 1);
    expect(shouldDisengage({ messagesSinceAddressed: 1, lastAddressedAt: t }, now, opts)).toBe(true);
    expect(shouldDisengage({ messagesSinceAddressed: 1, lastAddressedAt: new Date(now.getTime() - 3600_000) }, now, opts)).toBe(false);
    expect(shouldDisengage({ messagesSinceAddressed: 1, lastAddressedAt: null }, now, opts)).toBe(false);
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

describe('isStopMessage', () => {
  it.each(['stop', 'Stop!', '<@UBOT> shut up', 'please be quiet', 'ok stop it', 'STFU', 'go away bot', 'enough.', 'quiet please'])(
    'stop: %s',
    (t) => expect(isStopMessage(t)).toBe(true),
  );
  it.each(['stop by the shop later?', "don't stop believing", 'how do I stop a docker container', 'quietly fixed it', ''])('not stop: %s', (t) =>
    expect(isStopMessage(t)).toBe(false),
  );
});

describe('debounceWindowMs', () => {
  it('scales with active runs', () => {
    expect(debounceWindowMs(false, { idleMs: 1000, busyMs: 3000 })).toBe(1000);
    expect(debounceWindowMs(true, { idleMs: 1000, busyMs: 3000 })).toBe(3000);
  });
});

describe('threadRootTs', () => {
  it('uses thread_ts when present, else ts', () => {
    expect(threadRootTs({ ts: '2.0', thread_ts: '1.0' })).toBe('1.0');
    expect(threadRootTs({ ts: '2.0' })).toBe('2.0');
  });
});
