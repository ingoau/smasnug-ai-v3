/** Code channels, pure parts: Slack error mapping, session ids, names, privacy, setView / setCommands args. */
import '../../tools/test-env.js';
import { describe, expect, it } from 'vitest';
import { commandsArg, setViewArgs } from './api.js';
import { CodeChannelError, toCodeChannelError } from './errors.js';
import { codeChannelDisplayName, deriveSessionId, resolveIsPrivate, SESSION_ID_MAX } from './ids.js';

const slackErr = (code: string) => Object.assign(new Error(code), { code: 'slack_webapi_platform_error', data: { ok: false, error: code } });

describe('toCodeChannelError', () => {
  it('maps feature_disabled / user_not_enabled to unavailable with a message for people', () => {
    for (const code of ['feature_disabled', 'user_not_enabled']) {
      const e = toCodeChannelError('agents.conversations.create', slackErr(code));
      expect(e).toBeInstanceOf(CodeChannelError);
      expect(e.slackError).toBe(code);
      expect(e.kind).toBe('unavailable');
      expect(e.unavailable).toBe(true);
      expect(e.userMessage).toMatch(/code channels/i);
      expect(e.userMessage).not.toContain(code);
      expect(e.method).toBe('agents.conversations.create');
      expect(e.cause).toBeDefined();
    }
  });

  it('groups the documented errors', () => {
    const kind = (code: string) => toCodeChannelError('agents.conversations.archive', slackErr(code)).kind;
    expect(kind('restricted_action')).toBe('not_allowed');
    expect(kind('not_authorized')).toBe('not_allowed');
    expect(kind('file_editing_disabled')).toBe('not_allowed');
    expect(kind('invalid_origin_link')).toBe('bad_request');
    expect(kind('channel_not_viewable')).toBe('bad_request');
    expect(kind('name_taken')).toBe('bad_request');
    expect(kind('already_archived')).toBe('gone');
    expect(kind('not_agent_channel')).toBe('gone');
    expect(kind('is_archived')).toBe('gone');
    expect(kind('channel_creation_failed')).toBe('transient');
    expect(kind('invite_failed')).toBe('transient');
  });

  it('unknown codes keep the code; errors without one (network) are transient', () => {
    const e = toCodeChannelError('agents.conversations.setView', slackErr('something_new'));
    expect(e.kind).toBe('unknown');
    expect(e.slackError).toBe('something_new');
    expect(e.userMessage).toContain('something_new');
    const net = toCodeChannelError('agents.conversations.setView', new Error('ECONNRESET'));
    expect(net.kind).toBe('transient');
    expect(net.slackError).toBe('unknown');
  });

  it('passes an existing CodeChannelError through', () => {
    const e = toCodeChannelError('agents.sessions.rename', slackErr('name_taken'));
    expect(toCodeChannelError('agents.conversations.create', e)).toBe(e);
  });
});

describe('deriveSessionId', () => {
  it('is deterministic per trigger and within Slack’s 64 chars', () => {
    const a = deriveSessionId({ via: 'tool', turnId: '123' });
    expect(deriveSessionId({ via: 'tool', turnId: '123', n: 0 })).toBe(a);
    expect(a.length).toBeLessThanOrEqual(SESSION_ID_MAX);
    expect(a).toMatch(/^smasnug-tool-[0-9a-f]{32}$/);
  });

  it('differs between triggers', () => {
    const ids = new Set([
      deriveSessionId({ via: 'tool', turnId: '123' }),
      deriveSessionId({ via: 'tool', turnId: '123', n: 1 }),
      deriveSessionId({ via: 'tool', turnId: '124' }),
      deriveSessionId({ via: 'button', replyButtonsId: '123', index: 0 }),
      deriveSessionId({ via: 'button', replyButtonsId: '123', index: 1 }),
      deriveSessionId({ via: 'adopt', channelId: 'C123' }),
    ]);
    expect(ids.size).toBe(6);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(SESSION_ID_MAX);
  });
});

describe('names and privacy', () => {
  it('prefixes the bot name, collapses whitespace and caps at 200', () => {
    expect(codeChannelDisplayName('  fix\nthe   login ', 'smasnug ai')).toBe('smasnug ai: fix the login');
    expect(codeChannelDisplayName('', 'smasnug ai')).toBe('smasnug ai: session');
    const long = codeChannelDisplayName('x'.repeat(500), 'smasnug ai');
    expect([...long].length).toBe(200);
    expect(long.endsWith('…')).toBe(true);
  });

  it('DM origins and private: true force private; otherwise is_private is omitted', () => {
    expect(resolveIsPrivate({ originIsDm: true })).toBe(true);
    expect(resolveIsPrivate({ originIsDm: false, private: true })).toBe(true);
    expect(resolveIsPrivate({ originIsDm: false })).toBeUndefined();
    expect(resolveIsPrivate({ originIsDm: false, private: false })).toBeUndefined();
  });
});

describe('setViewArgs / commandsArg', () => {
  it('builds each view type', () => {
    expect(setViewArgs('C1', { type: 'html', viewKey: 'k', name: 'Page', content: '<html></html>', resourceDomains: ['https://cdn.example'] })).toEqual({
      channel_id: 'C1',
      type: 'html',
      name: 'Page',
      view_key: 'k',
      content: '<html></html>',
      csp: { resource_domains: ['https://cdn.example'] },
    });
    expect(setViewArgs('C1', { type: 'diff', content: '--- a' })).toEqual({ channel_id: 'C1', type: 'diff', content: '--- a' });
    expect(setViewArgs('C1', { type: 'block_kit', viewKey: 'b', blocks: [{ type: 'divider' }] })).toEqual({
      channel_id: 'C1',
      type: 'block_kit',
      view_key: 'b',
      blocks: [{ type: 'divider' }],
    });
    expect(setViewArgs('C1', { type: 'canvas', viewKey: 'c', canvasId: 'F1', accessLevel: 'read' })).toEqual({
      channel_id: 'C1',
      type: 'canvas',
      view_key: 'c',
      canvas_id: 'F1',
      access_level: 'read',
    });
  });

  it('refuses bad input before calling Slack', () => {
    const bad = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(CodeChannelError);
        expect((e as CodeChannelError).kind).toBe('bad_request');
        return;
      }
      throw new Error('expected a throw');
    };
    bad(() => setViewArgs('C1', { type: 'html', viewKey: '', content: 'x' }));
    bad(() => setViewArgs('C1', { type: 'html', viewKey: 'k', content: 'x'.repeat(1_000_001) }));
    bad(() => setViewArgs('C1', { type: 'html', viewKey: 'k', content: 'x', resourceDomains: ['http://insecure.example'] }));
    bad(() => setViewArgs('C1', { type: 'html', viewKey: 'k', content: 'x', resourceDomains: Array.from({ length: 21 }, (_, i) => `https://d${i}.example`) }));
  });

  it('strips a leading slash and maps optional fields', () => {
    expect(commandsArg([{ name: '/archive', description: 'Archive this channel' }, { name: 'rename', description: 'Rename', argumentHint: '<title>', shouldEscape: false }])).toEqual([
      { name: 'archive', description: 'Archive this channel' },
      { name: 'rename', description: 'Rename', argument_hint: '<title>', should_escape: false },
    ]);
  });
});

describe('parent-message marker', async () => {
  const { parentMessageMetadata, parseParentMessage, PARENT_MESSAGE_EVENT_TYPE } = await import('./parent-message.js');
  it('round-trips through the metadata stage 3 posts', () => {
    const md = parentMessageMetadata({ parentThreadId: 'C1:1790000000.000100', requesterId: 'U0INGO' });
    expect(md.event_type).toBe(PARENT_MESSAGE_EVENT_TYPE);
    expect(parseParentMessage({ metadata: md })).toEqual({ parentThreadId: 'C1:1790000000.000100', requesterId: 'U0INGO' });
  });
  it('rejects other metadata and malformed payloads', () => {
    expect(parseParentMessage({})).toBeNull();
    expect(parseParentMessage({ metadata: { event_type: 'other', event_payload: { parentThreadId: 'C1:1', requesterId: 'U1' } } })).toBeNull();
    expect(parseParentMessage({ metadata: { event_type: PARENT_MESSAGE_EVENT_TYPE, event_payload: { parentThreadId: 'C1:1' } } })).toBeNull();
    expect(parseParentMessage({ metadata: { event_type: PARENT_MESSAGE_EVENT_TYPE, event_payload: { parentThreadId: 'C1:1', requesterId: 'not a user' } } })).toBeNull();
  });
});
