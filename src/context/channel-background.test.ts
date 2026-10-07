import { describe, expect, it } from 'vitest';
import { pointsAtSomething, wantsChannelBackground } from './channel-background.js';

const want = (priorReplies: number, ...texts: string[]) => wantsChannelBackground({ priorReplies, newMessages: texts.map((text) => ({ text })), maxReplies: 3 });

describe('wantsChannelBackground', () => {
  it('always for a new top-level message or a short thread', () => {
    expect(want(0, 'how do i flash an esp32?')).toBe(true);
    expect(want(3, 'and what about the c3?')).toBe(true);
  });

  it('not in a longer thread when the message is self-contained', () => {
    expect(want(4, 'how do i flash an esp32?')).toBe(false);
    expect(want(20, '<@U123> can you look up the arduino uno r4 price in the uk')).toBe(false);
    expect(want(20, 'i tried that on windows and it still fails with a permission error when i run the build script')).toBe(false);
    expect(want(20)).toBe(false); // synthesis / scheduled turns
  });

  it('in a longer thread when the new message points at something', () => {
    for (const t of [
      '<@U123> ^',
      '^^ is this legit',
      '<@U123> this',
      'is that true?',
      'what do you think <@U123>',
      'thoughts?',
      'agree?',
      'wdyt',
      'see the message above',
      'what was the last message about',
      'fact check this pls',
      'explain this',
      'tldr?',
    ]) {
      expect(want(20, t), t).toBe(true);
    }
  });

  it('a bare ping (only mentions / punctuation) counts as pointing; one with a file does not', () => {
    expect(want(20, '<@U123>')).toBe(true);
    expect(want(20, '<@U123|bot> ?')).toBe(true);
    expect(wantsChannelBackground({ priorReplies: 20, newMessages: [{ text: '<@U123>', hasFiles: true }], maxReplies: 3 })).toBe(false);
  });

  it('any of several new messages can point', () => {
    expect(want(20, 'hey', 'what do you make of that')).toBe(true);
  });
});

describe('pointsAtSomething', () => {
  it('ignores carets in expressions and long messages that merely contain "this"', () => {
    expect(pointsAtSomething('what is 2^10 in hex')).toBe(false);
    expect(pointsAtSomething('this is my plan for the jam: we book the hall, buy pizza and run three workshops on saturday')).toBe(false);
    expect(pointsAtSomething('this is broken lol')).toBe(true); // short + deictic
  });
});
