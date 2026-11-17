import '../tools/test-env.js';
import { describe, expect, it } from 'vitest';
import { codeChannelThreadId, isCodeChannelRoot, parseThreadId, slackThreadTs, threadIdOf, threadTsArg } from './events.js';

describe('code channel thread ids', () => {
  it('the conversation root is `${channel}:0` and round-trips through parseThreadId', () => {
    expect(codeChannelThreadId('C123')).toBe('C123:0');
    expect(parseThreadId(codeChannelThreadId('C123'))).toEqual({ channelId: 'C123', threadTs: '0' });
    expect(isCodeChannelRoot(parseThreadId('C123:0').threadTs)).toBe(true);
    expect(isCodeChannelRoot('1700000000.000100')).toBe(false);
  });

  it('a Slack thread under a message in the channel keeps its own id', () => {
    expect(threadIdOf('C123', '1700000000.000100')).not.toBe(codeChannelThreadId('C123'));
  });

  it('slackThreadTs maps the root to no thread_ts and passes real ts through', () => {
    expect(slackThreadTs('0')).toBeUndefined();
    expect(slackThreadTs('')).toBeUndefined();
    expect(slackThreadTs(undefined)).toBeUndefined();
    expect(slackThreadTs(null)).toBeUndefined();
    expect(slackThreadTs('1700000000.000100')).toBe('1700000000.000100');
    // Only an exact `0`: a ts that merely starts with it is a real one.
    expect(slackThreadTs('0.5')).toBe('0.5');
  });

  it('threadTsArg omits the key entirely for the root', () => {
    expect(threadTsArg('0')).toEqual({});
    expect('thread_ts' in threadTsArg('0')).toBe(false);
    expect(threadTsArg('1700000000.000100')).toEqual({ thread_ts: '1700000000.000100' });
  });
});
