import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENROUTER_KEY ||= 'test';
});

const { decodeMessage, encodeCommand, parseChannelArg, songKey, trackLabel, unformatSlackText, capped } = await import('./protocol.js');
const { isDuplicateSong, pickResult, scoreResult } = await import('./match.js');
const { backoffMs, pickerPrompt, topUpRoom } = await import('./autodj.js');
const { playbackFromStatus } = await import('./store.js');
const { renderSession } = await import('./render.js');

describe('huddlefm protocol', () => {
  it('encodes commands so Slack leaves the JSON alone, and decodes back', () => {
    const text = encodeCommand({ type: 'add', channel: 'C1', reference: 'https://youtu.be/x?a=1&b=<2>' });
    expect(text).not.toMatch(/[<>&]/);
    expect(text).not.toContain('https://'); // no autolink
    expect(JSON.parse(text)).toEqual({ v: 1, type: 'add', channel: 'C1', reference: 'https://youtu.be/x?a=1&b=<2>' });
    expect(decodeMessage(text)).toMatchObject({ v: 1, type: 'add', reference: 'https://youtu.be/x?a=1&b=<2>' });
  });

  it("decodes HuddleFM messages after Slack's formatting (links, entities)", () => {
    const slackText = '{"v":1,"ok":true,"type":"search","replyTo":"1.2","results":[{"label":"A &amp; B","reference":"<https://x.com/a?b=1&amp;c=2>"}]}';
    const msg = decodeMessage(slackText);
    expect(msg?.replyTo).toBe('1.2');
    expect((msg?.results as any)[0]).toEqual({ label: 'A & B', reference: 'https://x.com/a?b=1&c=2' });
    expect(unformatSlackText('<https://a.b/c|a.b/c> &lt;x&gt;')).toBe('https://a.b/c <x>');
  });

  it('ignores anything that is not a v1 HuddleFM message', () => {
    expect(decodeMessage('hello')).toBeNull();
    expect(decodeMessage('{"v":2}')).toBeNull();
    expect(decodeMessage('{nope')).toBeNull();
    expect(decodeMessage('[1]')).toBeNull();
    expect(decodeMessage(undefined)).toBeNull();
  });

  it('labels and keys songs', () => {
    expect(trackLabel({ title: 'Song', artist: 'Band' })).toBe('Song - Band');
    expect(trackLabel({ title: 'Song' })).toBe('Song');
    expect(trackLabel(null)).toBe('');
    expect(songKey('Bohemian Rhapsody (Remastered 2011) - Queen')).toBe('bohemian rhapsody queen');
    expect(songKey('Señorita feat. Someone - Shawn Mendes')).toBe('senorita shawn mendes');
  });

  it('parses channel arguments', () => {
    expect(parseChannelArg('<#C0123ABCD|music>')).toBe('C0123ABCD');
    expect(parseChannelArg('C0123ABCD')).toBe('C0123ABCD');
    expect(parseChannelArg('#music')).toBeNull();
    expect(parseChannelArg(undefined)).toBeNull();
  });

  it('caps history lists, newest last', () => {
    expect(capped(['a', 'b', 'c'], ['d', 'e'], 3)).toEqual(['c', 'd', 'e']);
  });
});

describe('search result matching', () => {
  const results = [
    { label: 'Mr. Brightside (Karaoke Version) - Sing King', reference: 'karaoke' },
    { label: 'Mr. Brightside - The Killers', reference: 'real' },
    { label: 'Mr. Brightside (Sped Up) - The Killers', reference: 'sped' },
  ];

  it('prefers the real song over karaoke / sped-up versions', () => {
    expect(pickResult({ title: 'Mr. Brightside', artist: 'The Killers' }, results, { strict: true })?.reference).toBe('real');
    expect(pickResult({ title: 'mr brightside the killers' }, results, { strict: false })?.reference).toBe('real');
  });

  it('keeps a variant someone asked for', () => {
    expect(pickResult({ title: 'Mr. Brightside sped up', artist: 'The Killers' }, results, { strict: true })?.reference).toBe('sped');
  });

  it('strict: skips when nothing matches instead of queueing a wrong song', () => {
    const wrong = [{ label: 'Brightside Blues - Some Other Band', reference: 'x' }];
    expect(pickResult({ title: 'Mr. Brightside', artist: 'The Killers' }, wrong, { strict: true })).toBeNull();
    expect(pickResult({ title: 'Anything' }, [], { strict: true })).toBeNull();
  });

  it("lenient: falls back to HuddleFM's top result for free-text requests", () => {
    const r = [
      { label: 'Peaches - Jack Black', reference: 'top' },
      { label: 'Other - Thing', reference: 'second' },
    ];
    expect(pickResult({ title: 'that bowser song from the mario movie' }, r, { strict: false })?.reference).toBe('top');
  });

  it('scores title and artist coverage', () => {
    const s = scoreResult({ title: 'Levitating', artist: 'Dua Lipa' }, 'Levitating - Dua Lipa');
    expect(s).toMatchObject({ title: 1, artist: 1, unwantedVariants: [] });
    expect(scoreResult({ title: 'Levitating', artist: 'Dua Lipa' }, 'Levitating (Cover) - Someone').unwantedVariants).toEqual(['cover']);
  });

  it('detects repeats across label formats', () => {
    const labels = ['Bohemian Rhapsody (Remastered 2011) - Queen', 'Africa - TOTO'];
    expect(isDuplicateSong({ title: 'Bohemian Rhapsody', artist: 'Queen' }, labels)).toBe(true);
    expect(isDuplicateSong({ title: 'Africa', artist: 'Toto' }, labels)).toBe(true);
    expect(isDuplicateSong({ title: 'Africa', artist: 'Weezer' }, labels)).toBe(false);
    expect(isDuplicateSong({ title: 'Rosanna', artist: 'Toto' }, labels)).toBe(false);
  });
});

describe('auto DJ', () => {
  it('tops up when few songs people queued are waiting (autoplay picks do not count)', () => {
    expect(topUpRoom({ queue: [] })).toBe(3);
    expect(topUpRoom({ queue: [{ title: 'a' }] })).toBe(2);
    expect(topUpRoom({ queue: [{ title: 'a' }, { title: 'b' }] })).toBe(0);
    expect(topUpRoom({ queue: [{ title: 'a' }, { title: 'auto', automatic: true }] })).toBe(2);
    expect(topUpRoom({ queue: [{ title: 'a' }], queueLimit: 2 })).toBe(1);
    expect(topUpRoom({ queue: [{ title: 'a', automatic: true }], queueLimit: 1 })).toBe(0);
  });

  it('backs off exponentially after misses, capped', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(20)).toBe(15 * 60_000);
  });

  it('gives the picker the vibe, taste signals and what to avoid', () => {
    const p = pickerPrompt({
      session: { vibe: '90s rnb', played: ['A - B'], picks: ['C - D'], requested: ['E - F'], skipped: ['G - H'] },
      nowPlaying: 'X - Y',
      queue: ['Q - R'],
      conversation: '<@U1>: more tlc pls',
      count: 5,
    });
    for (const s of ['90s rnb', 'X - Y', 'Q - R', 'A - B', 'C - D', 'E - F', 'G - H', 'more tlc pls', 'next 5 songs']) expect(p).toContain(s);
  });
});

describe('playback snapshot + rendering', () => {
  const status = {
    nowPlaying: { id: 't0', title: 'Now', artist: 'Artist' },
    queue: [
      { id: 't1', title: 'Next', artist: 'A' },
      { id: 't2', title: 'Auto', artist: 'B', automatic: true },
    ],
  };

  it('stores now playing and up next with track ids', () => {
    const p = playbackFromStatus(status, new Date(0));
    expect(p).toEqual({ nowPlaying: 'Now - Artist', queue: ['Next - A [trackId t1]', 'Auto - B [trackId t2] (autoplay)'], queueLength: 2, at: new Date(0).toISOString() });
  });

  it('renders a session for the agent', () => {
    const base = { channelId: 'C1', requestedBy: 'U1', autoDj: true, vibe: 'chill', chatter: false, playback: playbackFromStatus(status) } as any;
    const active = renderSession({ ...base, status: 'active' }, { channelId: 'C1' });
    expect(active).toContain("<#C1> (this channel): you're the DJ");
    expect(active).toContain('vibe "chill"');
    expect(active).toContain('now playing: Now - Artist');
    expect(active).toContain('1. Next - A [trackId t1]');
    expect(renderSession({ ...base, status: 'pending' }, { channelId: 'C2' })).toContain('waiting for the huddle host');
  });
});
