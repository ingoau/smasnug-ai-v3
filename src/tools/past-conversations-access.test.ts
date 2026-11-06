import { describe, expect, it } from 'vitest';
import { decidePastThread } from './past-conversations-access.js';

const S = 'USPEAKER';
const publicHere = { channelId: 'CPUB', kind: 'public_channel' as const };
const myDm = { channelId: 'DMINE', kind: 'dm' as const, imUserId: S };
const privateHere = { channelId: 'GPRIV', kind: 'private_channel' as const };

describe('decidePastThread', () => {
  it('always allows the current conversation', () => {
    expect(decidePastThread({ channelId: 'GPRIV', kind: 'private_channel' }, privateHere, S)).toBe('allow');
    expect(decidePastThread({ channelId: 'DMINE', kind: 'dm' }, myDm, S)).toBe('allow');
  });

  it('shows public (or unclassified) channels only after a public check', () => {
    expect(decidePastThread({ channelId: 'COTHER', kind: 'public_channel' }, publicHere, S)).toBe('needs_public');
    expect(decidePastThread({ channelId: 'COTHER', kind: 'unknown' }, publicHere, S)).toBe('needs_public');
  });

  it('never shows a DM or private conversation in a public or other private channel', () => {
    expect(decidePastThread({ channelId: 'DMINE', kind: 'dm' }, publicHere, S)).toBe('deny');
    expect(decidePastThread({ channelId: 'GOTHER', kind: 'private_channel' }, publicHere, S)).toBe('deny');
    expect(decidePastThread({ channelId: 'GOTHER', kind: 'group_dm' }, privateHere, S)).toBe('deny');
  });

  it("shows private channels in the speaker's own DM, if they are still a member", () => {
    expect(decidePastThread({ channelId: 'GOTHER', kind: 'private_channel' }, myDm, S)).toBe('needs_member');
    expect(decidePastThread({ channelId: 'GOTHER', kind: 'private_channel' }, { ...myDm, imUserId: 'USOMEONE' }, S)).toBe('deny');
    expect(decidePastThread({ channelId: 'DOTHER', kind: 'dm' }, myDm, S)).toBe('deny');
  });
});
