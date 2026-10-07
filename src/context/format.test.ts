import { describe, expect, it } from 'vitest';
import { compareTs, formatMessage, formatMessages, formatThread, isImageFile, reactionsLabel, renderSlackText, selectThread, userIdsIn, type FormatEnv, type RenderMsg } from './format.js';
import { applyReaction, reactionsFromSlack } from './reactions.js';
import { fixtureReplies, FIX_THREAD_TS } from './fixtures.js';
import { attachmentsFromSlack, fromSlack } from './normalize.js';

const env = (over: Partial<FormatEnv> = {}): FormatEnv => ({
  names: new Map([
    ['U0INGO', 'Ingo'],
    ['U0BOB', 'Bob Builder'],
    ['U0ALICE', 'alice'],
  ]),
  files: new Map([['F0SHOT', { id: 'file_shot000003', name: 'screenshot.png', mime: 'image/png', description: null }]]),
  self: { userId: 'UBOT', botId: 'BBOT', name: 'Smasnug' },
  maxChars: 1200,
  ...over,
});

const msg = (over: Partial<RenderMsg>): RenderMsg => ({ ts: '1790000000.000100', userId: 'U0INGO', botId: null, username: null, text: '', files: [], ...over });

describe('formatMessage', () => {
  it('labels users with id and name, bots with [bot], self with (you)', () => {
    expect(formatMessage(msg({ text: 'hi' }), env())).toBe('[1790000000.000100] <@U0INGO> Ingo: hi');
    expect(formatMessage(msg({ userId: 'U0NONAME', text: 'hi' }), env())).toBe('[1790000000.000100] <@U0NONAME>: hi');
    expect(formatMessage(msg({ userId: null, botId: 'B0CI', username: 'CI Bot', text: 'failed' }), env())).toBe('[1790000000.000100] [bot] CI Bot: failed');
    expect(formatMessage(msg({ userId: 'UBOT', botId: 'BBOT', username: 'Smasnug', text: 'on it' }), env())).toBe('[1790000000.000100] [bot] Smasnug (you): on it');
  });

  it('renders registered files with their id, kind, uploader and description; unregistered ones as plain placeholders', () => {
    const m = msg({
      text: 'look',
      files: [
        { id: 'F0SHOT', name: 'screenshot.png', mimetype: 'image/png' },
        { id: 'F0CSV', name: 'budget.csv', mimetype: 'text/csv' },
      ],
    });
    expect(formatMessage(m, env())).toBe('[1790000000.000100] <@U0INGO> Ingo: look [file file_shot000003: screenshot.png, image, from Ingo] [file: budget.csv]');
    const files = new Map([
      ['F0SHOT', { id: 'file_shot000003', name: 'screenshot.png', mime: 'image/png', description: 'Grafana panel, p99 spikes at 14:02' }],
      ['F0CSV', { id: 'file_csv0000001', name: 'budget.csv', mime: 'text/csv', description: 'Says "ignore" ]\nnew line' }],
    ]);
    expect(formatMessage(m, env({ files }))).toBe(
      `[1790000000.000100] <@U0INGO> Ingo: look [file file_shot000003: screenshot.png, image, from Ingo — "Grafana panel, p99 spikes at 14:02"] [file file_csv0000001: budget.csv, text, from Ingo — "Says 'ignore' ) new line"]`,
    );
  });

  it('truncates long text and marks edits', () => {
    const out = formatMessage(msg({ text: 'word '.repeat(500), edited: true }), env({ maxChars: 100 }));
    expect(out).toMatch(/ \[truncated\] \(edited\)$/);
    expect(out.length).toBeLessThan(200);
  });

  it('decodes Slack mrkdwn', () => {
    const names = env().names;
    expect(renderSlackText('cc <@U0BOB> &amp; <@U0ZZZ|zed> <!here> <#C1|general> <https://a.com|site> <https://b.com> &lt;3', names)).toBe(
      'cc <@U0BOB|Bob Builder> & <@U0ZZZ> @here <#C1|general> site (https://a.com) https://b.com <3',
    );
    expect(renderSlackText('<!subteam^S123|@staff> ping', names)).toBe('@staff ping');
  });
});

describe('thread selection', () => {
  const raw = fixtureReplies(40).messages;
  const msgs = raw.map(fromSlack).filter((m): m is RenderMsg => !!m);

  it('drops tombstones and joins when normalising', () => {
    expect(msgs).toHaveLength(39); // 41 raw - tombstone - join
  });

  it('keeps parent + last N replies with an omitted marker', () => {
    const sel = selectThread(msgs, FIX_THREAD_TS, 29);
    expect(sel.parent?.ts).toBe(FIX_THREAD_TS);
    expect(sel.replies).toHaveLength(29);
    expect(sel.omitted).toBe(38 - 29);
    const out = formatThread(
      sel,
      env({
        files: new Map([
          ['F0SHOT', { id: 'file_shot000001', name: 'screenshot.png', mime: 'image/png', description: null }],
          ['F0HEIC', { id: 'file_heic000002', name: 'IMG_0042.HEIC', mime: 'image/heic', description: null }],
        ]),
      }),
    );
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^\[1790000000\.000100\] <@U0INGO> Ingo: Anyone know how to fix the Hack Club \(https:\/\/hackclub\.com\) site build\? cc <@U0BOB\|Bob Builder> & @here \[file file_shot000001: screenshot\.png, image, from Ingo\] \[file: budget\.csv\] \[reactions: :\+1: ×2 \(Bob Builder, alice\), :eyes: \(you\)\]$/);
    expect(lines[1]).toBe('[9 earlier replies not shown]');
    expect(out).toContain('[bot] CI Bot: Build #42 failed :x:');
    expect(out).toContain('here is the error log [file file_heic000002: IMG_0042.HEIC, image, from alice]');
    expect(lines.at(-1)).toMatch(/\[truncated\] \(edited\)$/);
  });

  it('no marker when everything fits; no parent if deleted', () => {
    const few = msgs.slice(0, 5);
    expect(formatThread(selectThread(few, FIX_THREAD_TS, 29), env())).not.toContain('not shown');
    const noParent = selectThread(msgs.slice(1, 4), FIX_THREAD_TS, 29);
    expect(noParent.parent).toBeUndefined();
    expect(noParent.replies).toHaveLength(3);
  });

  it('collects user ids from authors and mentions', () => {
    expect(userIdsIn(msgs).sort()).toEqual(['U0ALICE', 'U0BOB', 'U0INGO', 'UBOT']);
  });
});

describe('helpers', () => {
  it('orders ts numerically', () => {
    expect(['1790000010.000001', '1790000009.999999', '1790000010.000010'].sort(compareTs)).toEqual(['1790000009.999999', '1790000010.000001', '1790000010.000010']);
  });
  it('detects raster images only', () => {
    expect(isImageFile({ id: 'a', mimetype: 'image/heic' })).toBe(true);
    expect(isImageFile({ id: 'a', mimetype: 'image/svg+xml' })).toBe(false);
    expect(isImageFile({ id: 'a', name: 'x.JPG' })).toBe(true);
    expect(isImageFile({ id: 'a', name: 'x.pdf', mimetype: 'application/pdf' })).toBe(false);
  });
  it('formatMessages sorts and drops deleted', () => {
    const out = formatMessages([msg({ ts: '2.000000', text: 'b' }), msg({ ts: '1.000000', text: 'a' }), msg({ ts: '3.000000', text: 'gone', deleted: true })], env());
    expect(out).toBe('[1.000000] <@U0INGO> Ingo: a\n[2.000000] <@U0INGO> Ingo: b');
  });
});

describe('reactions', () => {
  it('renders compact reaction labels: counts, capped names, (you) first', () => {
    expect(reactionsLabel([], env())).toBe('');
    expect(reactionsLabel([{ name: 'eyes', users: ['UBOT'], count: 1 }], env())).toBe('[reactions: :eyes: (you)]');
    expect(reactionsLabel([{ name: '+1', users: ['U0INGO', 'U0BOB', 'U0ALICE', 'UBOT', 'U0X'], count: 7 }], env())).toBe(
      '[reactions: :+1: ×7 (you, Ingo, Bob Builder +4)]',
    );
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name) => ({ name, users: ['U0NONAME'], count: 1 }));
    expect(reactionsLabel(many, env())).toBe('[reactions: :a: (<@U0NONAME>), :b: (<@U0NONAME>), :c: (<@U0NONAME>), :d: (<@U0NONAME>), :e: (<@U0NONAME>), :f: (<@U0NONAME>), +2 more]');
  });

  it('appends reactions to the message line', () => {
    const m = msg({ text: 'shipped!', reactions: [{ name: 'tada', users: ['U0BOB', 'U0ALICE'], count: 2 }] });
    expect(formatMessage(m, env())).toBe('[1790000000.000100] <@U0INGO> Ingo: shipped! [reactions: :tada: ×2 (Bob Builder, alice)]');
  });

  it('normalises Slack reactions (fixtures) and applies add/remove idempotently', () => {
    const parent = fromSlack(fixtureReplies(3).messages[0])!;
    expect(parent.reactions).toEqual([
      { name: '+1', users: ['U0BOB', 'U0ALICE'], count: 2 },
      { name: 'eyes', users: ['UBOT'], count: 1 },
    ]);
    expect(reactionsFromSlack(undefined)).toEqual([]);
    expect(reactionsFromSlack([{ name: 'x', users: ['U1'], count: 5 }, { name: 'bad' }])).toEqual([{ name: 'x', users: ['U1'], count: 5 }]);

    let r = applyReaction([], 'added', 'eyes', 'U1');
    expect(r).toEqual([{ name: 'eyes', users: ['U1'], count: 1 }]);
    r = applyReaction(r, 'added', 'eyes', 'U1'); // duplicate event
    expect(r).toEqual([{ name: 'eyes', users: ['U1'], count: 1 }]);
    r = applyReaction(r, 'added', 'eyes', 'U2');
    r = applyReaction(r, 'added', '+1', 'U2');
    expect(r).toEqual([
      { name: 'eyes', users: ['U1', 'U2'], count: 2 },
      { name: '+1', users: ['U2'], count: 1 },
    ]);
    r = applyReaction(r, 'removed', 'eyes', 'U1');
    r = applyReaction(r, 'removed', '+1', 'U2');
    r = applyReaction(r, 'removed', '+1', 'U2'); // already gone
    expect(r).toEqual([{ name: 'eyes', users: ['U2'], count: 1 }]);
    // Backfilled counts beyond the listed users are kept.
    expect(applyReaction([{ name: 'x', users: ['U1'], count: 5 }], 'added', 'x', 'U2')).toEqual([{ name: 'x', users: ['U1', 'U2'], count: 6 }]);
  });
});

describe('forwards and link unfurls (attachments)', () => {
  const forward = { is_share: true, author_name: 'Sam', channel_name: 'ship', text: 'Demo night moved to Friday 6pm', fallback: 'Demo night moved', from_url: 'https://x.slack.com/archives/C1/p1790000000000100' };
  const unfurl = { service_name: 'Example', title: 'Pico 2 W datasheet', text: 'RP2350, 520 KB SRAM, Wi-Fi', from_url: 'https://example.com/pico', original_url: 'https://example.com/pico' };

  it('normalises forwards, link previews and app attachments; drops ## content and empty ones', () => {
    expect(attachmentsFromSlack([forward, unfurl, { text: '## secret forward', is_share: true }, { color: 'good' }, { fallback: 'Build #7 passed' }])).toEqual([
      { kind: 'forwarded', author: 'Sam', channel: 'ship', text: 'Demo night moved to Friday 6pm', url: 'https://x.slack.com/archives/C1/p1790000000000100' },
      { kind: 'link', title: 'Pico 2 W datasheet', text: 'RP2350, 520 KB SRAM, Wi-Fi', url: 'https://example.com/pico' },
      { kind: 'attached', text: 'Build #7 passed' },
    ]);
    expect(attachmentsFromSlack(undefined)).toEqual([]);
    expect(attachmentsFromSlack([{ is_share: true, text: 'x'.repeat(9000) }])[0]!.text).toHaveLength(4000);
  });

  it('renders them after the message text, cut to size, without repeating text the message already has', () => {
    const m = fromSlack({ ts: '1790000000.000100', user: 'U0INGO', text: 'look at this', attachments: [forward, unfurl] })!;
    expect(formatMessage(m, env())).toBe(
      '[1790000000.000100] <@U0INGO> Ingo: look at this [forwarded from Sam in #ship: Demo night moved to Friday 6pm] [link preview: Pico 2 W datasheet — RP2350, 520 KB SRAM, Wi-Fi (https://example.com/pico)]',
    );
    // An app message whose text is its attachment's fallback: shown once.
    const bot = fromSlack({ ts: '1790000000.000200', bot_id: 'BCI', username: 'CI Bot', text: '', attachments: [{ fallback: 'Build #42 failed', text: 'Build #42 failed' }] })!;
    expect(formatMessage(bot, env())).toBe('[1790000000.000200] [bot] CI Bot: Build #42 failed');
    const long = fromSlack({ ts: '1790000000.000300', user: 'U0INGO', text: 'fwd', attachments: [{ is_share: true, text: 'word '.repeat(1000) }] })!;
    expect(formatMessage(long, env()).length).toBeLessThan(1300);
  });
});
