/** Code channels, pure lifecycle parts: the sweep's selection, closing texts, the adoption agent check, stop dedupe. */
import '../../tools/test-env.js';
import { describe, expect, it } from 'vitest';
import { nativeStopDedupeKey } from '../../pipeline/stop.js';
import { isOurAgentChannel } from './adopt.js';
import { closingText, parentClosingText, sweepAction } from './lifecycle.js';

const H = 60 * 60 * 1000;
const D = 24 * H;
const now = new Date('2026-11-17T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('sweepAction', () => {
  it('warns after 6 idle days, once', () => {
    expect(sweepAction({ lastActivityAt: ago(6 * D - H), warnedAt: null, archivedAt: null }, now)).toBeNull();
    expect(sweepAction({ lastActivityAt: ago(6 * D), warnedAt: null, archivedAt: null }, now)).toBe('warn');
    expect(sweepAction({ lastActivityAt: ago(6 * D + H), warnedAt: ago(H), archivedAt: null }, now)).toBeNull();
  });

  it('archives after 7 idle days, only once the warning has been out a day', () => {
    expect(sweepAction({ lastActivityAt: ago(7 * D), warnedAt: ago(D), archivedAt: null }, now)).toBe('archive');
    expect(sweepAction({ lastActivityAt: ago(9 * D), warnedAt: ago(2 * H), archivedAt: null }, now)).toBeNull();
    // Never warned (the sweep was down): warn first.
    expect(sweepAction({ lastActivityAt: ago(9 * D), warnedAt: null, archivedAt: null }, now)).toBe('warn');
  });

  it('leaves archived rows alone', () => {
    expect(sweepAction({ lastActivityAt: ago(30 * D), warnedAt: ago(20 * D), archivedAt: ago(19 * D) }, now)).toBeNull();
  });
});

describe('closing texts', () => {
  it('posts the summary with who asked, or the sweep reason, and a fallback without one', () => {
    expect(closingText({ summary: '- done', reason: 'command', actor: 'U1' })).toBe('*Closing summary*\n- done\n\n_<@U1> asked to archive this channel. Unarchive it to pick up where it left off._');
    expect(closingText({ summary: null, reason: 'sweep', actor: null })).toMatch(/could not be written[\s\S]*after a week without messages/);
    expect(parentClosingText({ channelId: 'C1', summary: '- done' })).toBe('<#C1> finished: - done');
  });
});

describe('isOurAgentChannel', () => {
  it('needs our bot user id among the agent bot ids', () => {
    expect(isOurAgentChannel({ agentBotUserIds: ['UX', 'UBOT'] }, 'UBOT')).toBe(true);
    expect(isOurAgentChannel({ agentBotUserIds: ['UX'] }, 'UBOT')).toBe(false);
    expect(isOurAgentChannel({}, 'UBOT')).toBe(false);
    expect(isOurAgentChannel({ agentBotUserIds: [''] }, '')).toBe(false);
  });
});

describe('nativeStopDedupeKey', () => {
  it('maps both event names of one stop to one key', () => {
    const a = nativeStopDedupeKey({ channel: 'C1', user: 'U1', streaming_message_ts: ['2.0', '1.0'] });
    expect(nativeStopDedupeKey({ channel: 'C1', user: 'U1', streaming_message_ts: ['1.0', '2.0'] })).toBe(a);
    expect(nativeStopDedupeKey({ channel: 'C1', user: 'U2', streaming_message_ts: ['1.0', '2.0'] })).not.toBe(a);
    expect(nativeStopDedupeKey({ channel: 'C1', thread_ts: '1.5', user: 'U1' })).not.toBe(nativeStopDedupeKey({ channel: 'C1', user: 'U1' }));
  });
});
