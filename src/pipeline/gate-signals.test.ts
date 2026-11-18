import { describe, expect, it } from 'vitest';
import { applyAdjustment, gateAdjustment, leadingName, otherMentions } from './gate-signals.js';

const BOT = 'UBOT';
const msg = (text: string, userId: string | null = 'U1', botId: string | null = null) => ({
  channelId: 'C1',
  ts: '1.1',
  threadId: 'C1:1.0',
  userId,
  botId,
  username: null,
  text,
  files: [],
  editedAt: null,
  deleted: false,
});
const bot = (text: string) => msg(text, BOT, 'B1');
const adj = (context: ReturnType<typeof msg>[], text: string, author = 'U1') => gateAdjustment({ context, newMessages: [msg(text, author)], botUserId: BOT, botName: 'smasnug ai' });

describe('gate signals', () => {
  it('(a) boosts a follow-up question right after the bot answered', () => {
    const a = adj([msg('<@UBOT> what board should I use?'), bot('a pico 2 w')], 'does it do bluetooth?');
    expect(a).toEqual({ delta: 0.1, signals: ['follows_bot'] });
    // The author's own messages in between still count: the bot is the most recent *other* speaker.
    expect(adj([bot('a pico 2 w'), msg('hmm')], 'how much is it').signals).toEqual(['follows_bot']);
  });

  it('no boost when another person spoke after the bot, or for a remark', () => {
    expect(adj([bot('a pico 2 w'), msg('nice', 'U2')], 'does it do bluetooth?')).toEqual({ delta: 0, signals: [] });
    // (d) a remark about the bot's list isn't a follow-up.
    expect(adj([bot('1. … 7. tacos')], '7 is the best one')).toEqual({ delta: 0, signals: [] });
  });

  it('(b) dampens a message that opens by @mentioning another person, and drops the boost', () => {
    const a = adj([bot('here is the schedule')], '<@U2> can you update the schedule on the website?');
    expect(a).toEqual({ delta: -0.25, signals: ['mentions_other_leading'] });
    expect(adj([], 'hey <@U2|sam>, can you check?').signals).toEqual(['mentions_other_leading']);
    expect(adj([], '<!subteam^S1|leads> anyone free?').signals).toEqual(['mentions_other_leading']);
  });

  it('dampens less for a mention later in the message', () => {
    expect(adj([bot('done')], 'can you ask <@U2> about it?')).toEqual({ delta: -0.1, signals: ['mentions_other'] });
  });

  it('(c) dampens a message addressed to someone else by name', () => {
    expect(adj([bot('done')], 'Sam, did you book the room?')).toEqual({ delta: -0.15, signals: ['addressed_by_name'] });
    expect(adj([], 'hey Sam can you check').signals).toEqual(['addressed_by_name']);
  });

  it('ignores mentions of the bot itself and the author, and leaves bot-mentioning batches alone', () => {
    expect(otherMentions('<@UBOT> and <@U1> and <@U2|x>', BOT, 'U1')).toEqual(['<@U2|x>']);
    expect(adj([bot('x')], '<@UBOT> ask <@U2>?')).toEqual({ delta: 0, signals: [] });
  });

  it('leading names skip interjections, adverbs and the bot\'s own name', () => {
    expect(leadingName('ok, what about this?', 'smasnug ai')).toBeNull();
    expect(leadingName('Honestly, no', 'smasnug ai')).toBeNull();
    expect(leadingName('smasnug, what is this?', 'smasnug ai')).toBeNull();
    expect(leadingName('Update: it shipped', 'smasnug ai')).toBeNull();
    expect(leadingName('Sam: done?', 'smasnug ai')).toBe('Sam');
    expect(leadingName('what about Sam, though', 'smasnug ai')).toBeNull();
  });

  it('clamps the adjusted probability', () => {
    expect(applyAdjustment(0.95, { delta: 0.1, signals: ['follows_bot'] })).toBe(1);
    expect(applyAdjustment(0.1, { delta: -0.25, signals: ['mentions_other_leading'] })).toBe(0);
  });
});
