import { describe, expect, it } from 'vitest';
import { compareTs, formatMessage, formatMessages, formatThread, isImageFile, renderSlackText, selectThread, userIdsIn, type FormatEnv, type RenderMsg } from './format.js';
import { fixtureReplies, FIX_THREAD_TS } from './fixtures.js';
import { fromSlack } from './normalize.js';

const env = (over: Partial<FormatEnv> = {}): FormatEnv => ({
  names: new Map([
    ['U0INGO', 'Ingo'],
    ['U0BOB', 'Bob Builder'],
    ['U0ALICE', 'alice'],
  ]),
  imageIds: new Map([['F0SHOT', 3]]),
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

  it('renders files and images with stable ids and the uploader name', () => {
    const m = msg({
      text: 'look',
      files: [
        { id: 'F0SHOT', name: 'screenshot.png', mimetype: 'image/png' },
        { id: 'F0CSV', name: 'budget.csv', mimetype: 'text/csv' },
      ],
    });
    expect(formatMessage(m, env())).toBe('[1790000000.000100] <@U0INGO> Ingo: look [image img_3: screenshot.png, from Ingo] [file: budget.csv]');
  });

  it('truncates long text and marks edits', () => {
    const out = formatMessage(msg({ text: 'word '.repeat(500), edited: true }), env({ maxChars: 100 }));
    expect(out).toMatch(/ \[truncated\] \(edited\)$/);
    expect(out.length).toBeLessThan(200);
  });

  it('decodes Slack mrkdwn', () => {
    const names = env().names;
    expect(renderSlackText('cc <@U0BOB> &amp; <@U0ZZZ|zed> <!here> <#C1|general> <https://a.com|site> <https://b.com> &lt;3', names)).toBe(
      'cc <@U0BOB|Bob Builder> & <@U0ZZZ> @here #general site (https://a.com) https://b.com <3',
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
    const out = formatThread(sel, env({ imageIds: new Map([['F0SHOT', 1], ['F0HEIC', 2]]) }));
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^\[1790000000\.000100\] <@U0INGO> Ingo: Anyone know how to fix the Hack Club \(https:\/\/hackclub\.com\) site build\? cc <@U0BOB\|Bob Builder> & @here \[image img_1: screenshot\.png, from Ingo\] \[file: budget\.csv\]$/);
    expect(lines[1]).toBe('[9 earlier replies not shown]');
    expect(out).toContain('[bot] CI Bot: Build #42 failed :x:');
    expect(out).toContain('here is the error log [image img_2: IMG_0042.HEIC, from alice]');
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
    expect(userIdsIn(msgs).sort()).toEqual(['U0ALICE', 'U0BOB', 'U0INGO']);
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
