/** Code channels, agent side, pure parts: tool gating, origin, create options, invites, texts. */
import '../../tools/test-env.js';
import { describe, expect, it } from 'vitest';
import {
  ALL_CODE_CHANNEL_TOOLS,
  createOptions,
  decodeInviteValue,
  encodeInviteValue,
  forkHandoffText,
  forkSeedText,
  hiddenCodeChannelTools,
  isCompleteHtml,
  MAX_INVITES,
  movedNote,
  offersMoveButton,
  parseChannelRef,
  parseUserId,
  partitionInvites,
  pickOrigin,
  quoteText,
} from './logic.js';
import { codeChannelDisplayName } from './ids.js';
import { isParentPostUsername, parentPostUsername, USERNAME_MAX } from './parent-message.js';
import { tailLines } from './seed.js';
import { MOVE_BUTTON_NOTE, renderChildrenSection } from './turn-context.js';

const gate = (o: Partial<Parameters<typeof hiddenCodeChannelTools>[0]> = {}) =>
  hiddenCodeChannelTools({ enabled: true, inCodeChannel: false, hasParent: false, liveChildren: 0, ...o }).sort();

describe('tool gating', () => {
  it('switched off: every code-channel tool is hidden, and no button offer', () => {
    expect(gate({ enabled: false })).toEqual([...ALL_CODE_CHANNEL_TOOLS].sort());
    expect(gate({ enabled: false, inCodeChannel: true, hasParent: true, liveChildren: 2 })).toEqual([...ALL_CODE_CHANNEL_TOOLS].sort());
    expect(offersMoveButton({ enabled: false, inCodeChannel: false })).toBe(false);
  });

  it('an ordinary thread can open one; parent tools only with live children', () => {
    expect(gate()).toEqual(['ask_code_channel', 'message_code_channel', 'remove_view', 'report_to_parent', 'set_view']);
    expect(gate({ liveChildren: 1 })).toEqual(['remove_view', 'report_to_parent', 'set_view']);
    expect(offersMoveButton({ enabled: true, inCodeChannel: false })).toBe(true);
  });

  it('inside a code channel: no nesting (no open, no parent tools); report_to_parent needs a parent', () => {
    expect(gate({ inCodeChannel: true, hasParent: true })).toEqual(['ask_code_channel', 'message_code_channel', 'open_code_channel']);
    expect(gate({ inCodeChannel: true })).toEqual(['ask_code_channel', 'message_code_channel', 'open_code_channel', 'report_to_parent']);
    // Even if rows claim children (they can't), a code channel never gets parent tools.
    expect(gate({ inCodeChannel: true, hasParent: true, liveChildren: 3 })).toContain('message_code_channel');
    expect(offersMoveButton({ enabled: true, inCodeChannel: true })).toBe(false);
  });
});

describe('origin', () => {
  const latest = { ts: '1700000000.000300', userId: 'U2' };
  it('fork: the latest user message', () => {
    expect(pickOrigin({ fork: true, triggerTs: '1700000000.000200', latestUserMessage: latest })).toEqual({ ts: latest.ts, authorId: 'U2' });
    expect(pickOrigin({ fork: true, triggerTs: '1700000000.000200', latestUserMessage: null })).toBeNull();
  });
  it('brief: the triggering message, else the latest user message', () => {
    expect(pickOrigin({ fork: false, triggerTs: '1700000000.000200', latestUserMessage: latest })).toEqual({ ts: '1700000000.000200', authorId: null });
    expect(pickOrigin({ fork: false, triggerTs: latest.ts, latestUserMessage: latest })).toEqual({ ts: latest.ts, authorId: 'U2' });
    expect(pickOrigin({ fork: false, triggerTs: null, latestUserMessage: latest })).toEqual({ ts: latest.ts, authorId: 'U2' });
    expect(pickOrigin({ fork: false })).toBeNull();
  });
  it('a DM origin: private and no origin link; private: true forces private; otherwise privacy follows the origin', () => {
    const origin = { channelId: 'D1', ts: '1.1' };
    expect(createOptions({ originIsDm: true, origin })).toEqual({ isPrivate: true });
    expect(createOptions({ originIsDm: false, origin: { channelId: 'C1', ts: '1.1' } })).toEqual({ origin: { channelId: 'C1', ts: '1.1' } });
    expect(createOptions({ originIsDm: false, private: true, origin: { channelId: 'C1', ts: '1.1' } })).toEqual({ isPrivate: true, origin: { channelId: 'C1', ts: '1.1' } });
    expect(createOptions({ originIsDm: false, origin: null })).toEqual({});
  });
});

describe('invites', () => {
  const members = new Set(['U1', 'U2']);
  const isOriginMember = (u: string) => members.has(u);
  it('origin members directly, others need confirmation; deduped, excluded and junk dropped', () => {
    const r = partitionInvites({ members: ['<@U1|ann>', 'U2', 'U3', '<@U3>', 'USPEAKER', 'bob', 'UBOT'], originIsDm: false, isOriginMember, exclude: new Set(['USPEAKER', 'UBOT']) });
    expect(r).toEqual({ direct: ['U1', 'U2'], confirm: ['U3'], invalid: ['bob'] });
  });
  it('from a DM everyone needs confirmation', () => {
    expect(partitionInvites({ members: ['U1', 'U3'], originIsDm: true, isOriginMember, exclude: new Set() })).toEqual({ direct: [], confirm: ['U1', 'U3'], invalid: [] });
  });
  it('caps the number of invites', () => {
    const many = Array.from({ length: MAX_INVITES + 5 }, (_, i) => `U${String(i).padStart(4, '0')}`);
    const r = partitionInvites({ members: many, originIsDm: false, isOriginMember: () => true, exclude: new Set() });
    expect(r.direct).toHaveLength(MAX_INVITES);
  });
  it('parses user and channel references', () => {
    expect(parseUserId('<@U0ABC|Ann>')).toBe('U0ABC');
    expect(parseUserId(' W0ABC ')).toBe('W0ABC');
    expect(parseUserId('@ann')).toBeNull();
    expect(parseChannelRef('<#C0CODE|smasnug-ai-x>')).toBe('C0CODE');
    expect(parseChannelRef('#C0CODE')).toBe('C0CODE');
    expect(parseChannelRef('general')).toBeNull();
  });
  it('the confirmation value round-trips and rejects junk', () => {
    const v = { c: 'C0CODE', u: ['U1', 'U2'], r: 'U9' };
    expect(decodeInviteValue(encodeInviteValue(v))).toEqual(v);
    expect(decodeInviteValue('nope')).toBeNull();
    expect(decodeInviteValue(JSON.stringify({ c: 'C0CODE', u: ['bad'], r: 'U9' }))).toBeNull();
    expect(decodeInviteValue(JSON.stringify({ c: 'x', u: ['U1'], r: 'U9' }))).toBeNull();
  });
});

describe('names and texts', () => {
  it('channel and parent-post names', () => {
    expect(codeChannelDisplayName('  login   bug ', 'smasnug ai')).toBe('smasnug ai: login bug');
    expect(parentPostUsername('smasnug ai', '#general')).toBe('smasnug ai · from #general');
    expect([...parentPostUsername('smasnug ai', `#${'x'.repeat(200)}`)].length).toBe(USERNAME_MAX);
    expect(isParentPostUsername('smasnug ai · from #general', 'smasnug ai')).toBe(true);
    expect(isParentPostUsername('smasnug ai', 'smasnug ai')).toBe(false);
    expect(isParentPostUsername(null, 'smasnug ai')).toBe(false);
  });
  it('seed, hand-off and moved note', () => {
    expect(forkSeedText({ permalink: 'https://x/p1', summary: 'stuff' })).toBe('Forked from <https://x/p1|this thread>.\n\nstuff');
    expect(forkSeedText({ summary: null })).toMatch(/^Forked from a thread\.\n\n_No summary/);
    expect(forkHandoffText({ authorId: 'U1', text: 'line 1\nline 2', permalink: 'https://x/p2' })).toBe('<@U1> wrote in <https://x/p2|the thread>:\n> line 1\n> line 2');
    expect(quoteText('x'.repeat(10), 4)).toBe('> xxxx…');
    expect(movedNote({ channelId: 'C1', seedPermalink: 'https://x/p3' })).toBe('Moved → <https://x/p3|code channel>');
    expect(movedNote({ channelId: 'C1' })).toBe('Moved → <#C1>');
  });
  it('HTML tabs must be complete documents', () => {
    expect(isCompleteHtml('<!doctype html><html><body>hi</body></html>\n')).toBe(true);
    expect(isCompleteHtml('<div>hi</div>')).toBe(false);
    expect(isCompleteHtml('<html><body>cut off')).toBe(false);
  });
  it('the seed input keeps the newest lines', () => {
    expect(tailLines('a\nb\nc', 100)).toBe('a\nb\nc');
    expect(tailLines('aaaa\nbbbb\ncccc', 10)).toBe('[older messages left out]\nbbbb\ncccc');
  });
  it('the button note names the action; the children section lists channels', () => {
    expect(MOVE_BUTTON_NOTE).toContain('"tool": "move_to_code_channel"');
    expect(MOVE_BUTTON_NOTE).toMatch(/again/);
    const now = new Date('2026-11-16T12:00:00Z');
    const row = { channelId: 'C0CODE', name: 'smasnug ai: x', kind: 'fork', lastActivityAt: new Date('2026-11-14T11:00:00Z'), archivedAt: null } as any;
    const text = renderChildrenSection({ enabled: true, here: null, topLevel: false, children: [row] }, now);
    expect(text).toContain('<#C0CODE|smasnug ai: x> (channel "C0CODE"), forked from a thread, last activity 2 days ago');
    expect(renderChildrenSection({ enabled: true, here: null, topLevel: false, children: [] }, now)).toBe('');
  });
});
