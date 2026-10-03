import { describe, expect, it } from 'vitest';
import {
  broadcastSafePrefix,
  groupRedirectText,
  hasGroupPing,
  hasQuietPrefix,
  isBangStop,
  isHiddenMessage,
  neutralizeBroadcasts,
  shouldRedirectGroupPing,
} from './guidelines.js';
import { decide, type MessageFacts } from './rules.js';

const BOT = 'UBOT';

describe('## prefix (hidden)', () => {
  it('matches ## after optional leading whitespace', () => {
    expect(isHiddenMessage('## note to self')).toBe(true);
    expect(isHiddenMessage('##')).toBe(true);
    expect(isHiddenMessage('  \n\t## indented')).toBe(true);
    expect(isHiddenMessage(`## <@${BOT}> hi`)).toBe(true);
  });
  it('does not match otherwise', () => {
    expect(isHiddenMessage('# heading')).toBe(false);
    expect(isHiddenMessage('hello ## world')).toBe(false);
    expect(isHiddenMessage(`<@${BOT}> ## hi`)).toBe(false);
    expect(isHiddenMessage('')).toBe(false);
    expect(isHiddenMessage(undefined)).toBe(false);
  });
});

describe('<> prefix (quiet)', () => {
  it('matches the literal two characters, raw or entity-escaped', () => {
    expect(hasQuietPrefix('<> just chatting')).toBe(true);
    expect(hasQuietPrefix('&lt;&gt; just chatting')).toBe(true);
    expect(hasQuietPrefix('   &lt;&gt;hi')).toBe(true);
    expect(hasQuietPrefix('&lt;>hi')).toBe(true);
    expect(hasQuietPrefix('<&gt;hi')).toBe(true);
    expect(hasQuietPrefix(`<> <@${BOT}> hi`)).toBe(true);
  });
  it('does not confuse Slack mention / link / channel markup with the prefix', () => {
    expect(hasQuietPrefix(`<@${BOT}> <> hi`)).toBe(false);
    expect(hasQuietPrefix('<#C123|general> hi')).toBe(false);
    expect(hasQuietPrefix('<https://example.com> hi')).toBe(false);
    expect(hasQuietPrefix('<!here> hi')).toBe(false);
    expect(hasQuietPrefix('&lt; &gt; spaced')).toBe(false);
    expect(hasQuietPrefix('hi <>')).toBe(false);
    expect(hasQuietPrefix(undefined)).toBe(false);
  });
});

describe('group pings', () => {
  it('detects user groups and broadcasts in all mention forms', () => {
    expect(hasGroupPing('<!subteam^S0123ABC> help')).toBe(true);
    expect(hasGroupPing('<!subteam^S0123ABC|@design-team> help')).toBe(true);
    expect(hasGroupPing('hey <!channel>')).toBe(true);
    expect(hasGroupPing('<!here|here> pls')).toBe(true);
    expect(hasGroupPing('<!everyone>')).toBe(true);
  });
  it('ignores users, channels, dates and plain text', () => {
    expect(hasGroupPing(`<@${BOT}> <@U0BOB> hi`)).toBe(false);
    expect(hasGroupPing('<#C123|general>')).toBe(false);
    expect(hasGroupPing('<!date^1700000000^{date}|Nov 14>')).toBe(false);
    expect(hasGroupPing('@here as plain text')).toBe(false);
  });
  it('redirects only top-level channel messages that mention the bot', () => {
    const base = { isDm: false, ts: '1.1', mentionsBot: true, text: `<!subteam^S1|@team> <@${BOT}> help` };
    expect(shouldRedirectGroupPing(base)).toBe(true);
    expect(shouldRedirectGroupPing({ ...base, threadTs: '1.1' })).toBe(true); // a parent carries thread_ts = ts
    expect(shouldRedirectGroupPing({ ...base, threadTs: '1.0' })).toBe(false); // thread reply
    expect(shouldRedirectGroupPing({ ...base, isDm: true })).toBe(false);
    expect(shouldRedirectGroupPing({ ...base, mentionsBot: false })).toBe(false);
    expect(shouldRedirectGroupPing({ ...base, text: `<@${BOT}> help` })).toBe(false);
  });
  it('redirect text pings the asker only', () => {
    const t = groupRedirectText('U0ASK', 'https://x.slack.com/archives/C1/p1');
    expect(t).toContain('<@U0ASK>');
    expect(t).toContain('<https://x.slack.com/archives/C1/p1|this message>');
    expect(hasGroupPing(t)).toBe(false);
  });
});

describe('@bot !stop', () => {
  it('needs the bot mention (except in DMs) and exactly !stop otherwise', () => {
    expect(isBangStop(`<@${BOT}> !stop`, BOT)).toBe(true);
    expect(isBangStop(`  <@${BOT}|smasnug>   !STOP  `, BOT)).toBe(true);
    expect(isBangStop(`!stop <@${BOT}>`, BOT)).toBe(true);
    expect(isBangStop('!stop', BOT)).toBe(false);
    expect(isBangStop('!stop', BOT, { isDm: true })).toBe(true);
    expect(isBangStop(`<@${BOT}> !stop please`, BOT)).toBe(false);
    expect(isBangStop(`<@${BOT}> stop`, BOT)).toBe(false);
    expect(isBangStop(`<@${BOT}> <@U0BOB> !stop`, BOT)).toBe(false);
    expect(isBangStop(`<@U0BOB> !stop`, BOT)).toBe(false);
  });
});

describe('broadcast neutralisation', () => {
  it('neutralises every group ping form', () => {
    const out = neutralizeBroadcasts('hey <!channel> <!here|here> <!everyone> <!subteam^S1|@design> <!subteam^S2> @here (@channel) ok');
    expect(hasGroupPing(out)).toBe(false);
    expect(out).not.toMatch(/(^|[^​])@(here|channel|everyone)\b/);
    expect(out).toContain('@​design');
    expect(out).toContain('@​group');
    expect(neutralizeBroadcasts('mail me@here.com, <@U1> hi')).toBe('mail me@here.com, <@U1> hi');
  });
  it('streaming prefixes hold back incomplete pings and stay prefixes of the final text', () => {
    const full = 'ping <!subteam^S1|@team> and @here now';
    const final = neutralizeBroadcasts(full);
    for (let i = 0; i <= full.length; i++) {
      const p = broadcastSafePrefix(full.slice(0, i));
      expect(final.startsWith(p)).toBe(true);
      expect(hasGroupPing(p)).toBe(false);
    }
    expect(broadcastSafePrefix('hi <!sub')).toBe('hi ');
    expect(broadcastSafePrefix('hi @her')).toBe('hi ');
    expect(broadcastSafePrefix('hi <')).toBe('hi ');
  });
});

describe('decide: <> prefix', () => {
  const facts = (over: Partial<MessageFacts> = {}): MessageFacts => ({
    isBot: false,
    isDm: false,
    mentionsBot: false,
    mentionsOthers: false,
    engaged: true,
    disengageDue: false,
    twoParty: true,
    isStop: false,
    ...over,
  });
  it('ignores <> messages unless the bot is mentioned, also in DMs', () => {
    expect(decide(facts({ quietPrefix: true }))).toEqual({ action: 'ignore', reason: 'quiet' });
    expect(decide(facts({ quietPrefix: true, isDm: true }))).toEqual({ action: 'ignore', reason: 'quiet' });
    expect(decide(facts({ quietPrefix: true, twoParty: false }))).toEqual({ action: 'ignore', reason: 'quiet' });
    expect(decide(facts({ quietPrefix: true, isStop: true }))).toEqual({ action: 'ignore', reason: 'quiet' });
    expect(decide(facts({ quietPrefix: true, mentionsBot: true }))).toEqual({ action: 'batch', reason: 'mention' });
    expect(decide(facts({ quietPrefix: true, isDm: true, mentionsBot: true }))).toEqual({ action: 'batch', reason: 'dm' });
  });
});
