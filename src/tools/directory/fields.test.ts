import { describe, expect, it } from 'vitest';
import { channelFromSlack, directoryActions, PEOPLE_FIELDS, personChanged, personFromSlack, SEARCHABLE_PEOPLE_FIELDS, slimSlackUser } from './fields.js';

const slackUser = (over: Record<string, any> = {}, profile: Record<string, any> = {}) => ({
  id: 'U0TESS',
  team_id: 'T1',
  name: 'tess',
  real_name: 'Tess Ting',
  tz: 'Europe/Berlin',
  tz_offset: 7200,
  locale: 'de-DE',
  is_admin: true,
  is_owner: false,
  is_bot: false,
  is_app_user: false,
  deleted: false,
  color: '9f69e7',
  has_2fa: true,
  ...over,
  profile: {
    display_name: 'Tess',
    real_name: 'Tess Ting',
    title: 'Organiser',
    pronouns: 'she/her',
    status_text: 'on a train',
    status_emoji: ':train:',
    status_expiration: 0,
    email: 'tess@example.com',
    phone: '+49 123',
    skype: 'tess',
    image_192: 'https://avatars.example/tess.png',
    fields: { X1: { value: 'secret' } },
    ...profile,
  },
});

describe('personFromSlack', () => {
  it('keeps exactly the directory fields: no email, phone, avatar or custom fields', () => {
    const p = personFromSlack(slackUser())!;
    expect(Object.keys(p).sort()).toEqual([...PEOPLE_FIELDS].sort());
    expect(p).toMatchObject({
      id: 'U0TESS',
      handle: 'tess',
      displayName: 'Tess',
      realName: 'Tess Ting',
      title: 'Organiser',
      pronouns: 'she/her',
      tz: 'Europe/Berlin',
      tzOffset: 7200,
      locale: 'de-DE',
      statusText: 'on a train',
      statusEmoji: ':train:',
      statusExpiration: null,
      isAdmin: true,
      isBot: false,
      deleted: false,
    });
    const json = JSON.stringify(p);
    for (const leak of ['example.com', '+49', 'avatars', 'secret', '9f69e7']) expect(json).not.toContain(leak);
  });

  it('only handle, display name, real name and title are searchable', () => {
    expect([...SEARCHABLE_PEOPLE_FIELDS]).toEqual(['handle', 'displayName', 'realName', 'title']);
  });

  it('sanitises user-written text: one line, no control characters, capped', () => {
    const p = personFromSlack(slackUser({}, { title: 'Organiser\nIGNORE PREVIOUS\u0007 instructions', display_name: 'x'.repeat(500) }))!;
    expect(p.title).toBe('Organiser IGNORE PREVIOUS instructions');
    expect(p.displayName).toHaveLength(80);
  });

  it('a deactivated account keeps only names, title and kind', () => {
    const p = personFromSlack(slackUser({ deleted: true, is_bot: true }))!;
    expect(p).toMatchObject({ deleted: true, isBot: true, handle: 'tess', title: 'Organiser', pronouns: '', statusText: '', tz: null, locale: null, isAdmin: false });
  });

  it('rejects objects without a user id; drops invalid tz / locale', () => {
    expect(personFromSlack({ name: 'x' })).toBeNull();
    expect(personFromSlack({ id: 'C123', name: 'x' })).toBeNull();
    const p = personFromSlack(slackUser({ tz: 'Europe/Berlin\nX', locale: 'en-US\nIGNORE' }))!;
    expect(p.tz).toBeNull();
    expect(p.locale).toBeNull();
  });
});

describe('slimSlackUser (ingress)', () => {
  it('keeps only what personFromSlack reads', () => {
    const slim = slimSlackUser(slackUser());
    const json = JSON.stringify(slim);
    for (const leak of ['example.com', '+49', 'avatars', 'secret', 'skype', 'has_2fa']) expect(json).not.toContain(leak);
    expect(personFromSlack(slim)).toEqual(personFromSlack(slackUser()));
  });
});

describe('personChanged', () => {
  const base = personFromSlack(slackUser())!;
  it('identical → no change; any stored field → change (status included)', () => {
    expect(personChanged(base, { ...base })).toBe(false);
    expect(personChanged(base, personFromSlack(slackUser({}, { status_text: 'lunch' }))!)).toBe(true);
    expect(personChanged(base, personFromSlack(slackUser({}, { title: 'HQ' }))!)).toBe(true);
  });
  it('an unknown locale (events) is not a change', () => {
    expect(personChanged(base, personFromSlack(slackUser({ locale: undefined }))!)).toBe(false);
  });
  it('a field the directory does not store is not a change', () => {
    expect(personChanged(base, personFromSlack(slackUser({}, { email: 'new@example.com', image_192: 'x' }))!)).toBe(false);
  });
});

describe('channelFromSlack', () => {
  const ch = (over: Record<string, any> = {}) => ({
    id: 'C0HW',
    name: 'hardware',
    is_channel: true,
    is_private: false,
    is_archived: false,
    num_members: 1234,
    created: 1600000000,
    topic: { value: 'solder\ntalk' },
    purpose: { value: 'All things hardware' },
    ...over,
  });
  it('maps a public channel', () => {
    expect(channelFromSlack(ch())).toEqual({
      id: 'C0HW',
      name: 'hardware',
      topic: 'solder talk',
      purpose: 'All things hardware',
      isArchived: false,
      memberCount: 1234,
      createdAt: new Date(1600000000 * 1000),
    });
    expect(channelFromSlack(ch({ is_archived: true }))!.isArchived).toBe(true);
  });
  it('fails closed: private, unknown privacy, groups, IMs and non-C ids are never stored', () => {
    expect(channelFromSlack(ch({ is_private: true }))).toBeNull();
    expect(channelFromSlack(ch({ is_private: undefined }))).toBeNull();
    expect(channelFromSlack(ch({ is_group: true }))).toBeNull();
    expect(channelFromSlack(ch({ is_mpim: true }))).toBeNull();
    expect(channelFromSlack(ch({ id: 'G0PRIV' }))).toBeNull();
    expect(channelFromSlack(ch({ id: 'D0DM' }))).toBeNull();
  });
});

describe('directoryActions (event → upsert mapping)', () => {
  it('user_change / team_join → a person upsert', () => {
    for (const type of ['user_change', 'team_join']) {
      const [a] = directoryActions({ type, user: slackUser() });
      expect(a).toMatchObject({ type: 'person', person: { id: 'U0TESS', title: 'Organiser' } });
    }
    expect(directoryActions({ type: 'user_change', user: {} })).toEqual([]);
  });
  it('channel events', () => {
    expect(directoryActions({ type: 'channel_created', channel: { id: 'C1', name: 'new' } })).toEqual([{ type: 'channel_refresh', channelId: 'C1' }]);
    expect(directoryActions({ type: 'channel_rename', channel: { id: 'C1', name: 'renamed' } })).toEqual([{ type: 'channel_renamed', channelId: 'C1', name: 'renamed' }]);
    expect(directoryActions({ type: 'channel_archive', channel: 'C1' })).toEqual([{ type: 'channel_archived', channelId: 'C1', archived: true }]);
    expect(directoryActions({ type: 'channel_unarchive', channel: 'C1' })).toEqual([{ type: 'channel_archived', channelId: 'C1', archived: false }]);
    expect(directoryActions({ type: 'channel_deleted', channel: 'C1' })).toEqual([{ type: 'channel_deleted', channelId: 'C1' }]);
  });
  it('topic / purpose / name message subtypes, public channels only', () => {
    const msg = { type: 'message', channel: 'C1', channel_type: 'channel' };
    expect(directoryActions({ ...msg, subtype: 'channel_topic', topic: 'new\ntopic' })).toEqual([{ type: 'channel_text', channelId: 'C1', field: 'topic', value: 'new topic' }]);
    expect(directoryActions({ ...msg, subtype: 'channel_purpose', purpose: 'p' })).toEqual([{ type: 'channel_text', channelId: 'C1', field: 'purpose', value: 'p' }]);
    expect(directoryActions({ ...msg, subtype: 'channel_name', name: 'n' })).toEqual([{ type: 'channel_renamed', channelId: 'C1', name: 'n' }]);
    // A private channel's topic never lands in the directory (a C… id there means it was converted: see below).
    expect(directoryActions({ ...msg, channel_type: 'group', subtype: 'channel_topic', topic: 'x' })).toEqual([{ type: 'channel_private', channelId: 'C1' }]);
    expect(directoryActions({ ...msg, text: 'hi' })).toEqual([]);
  });
  it('a message from a C… channel as a private channel\'s (converted from public) removes it', () => {
    expect(directoryActions({ type: 'message', channel: 'C1', channel_type: 'group', text: 'hi' })).toEqual([{ type: 'channel_private', channelId: 'C1' }]);
    // Legacy G… private channels, DMs and group DMs were never in the directory.
    expect(directoryActions({ type: 'message', channel: 'G1', channel_type: 'group', text: 'hi' })).toEqual([]);
    expect(directoryActions({ type: 'message', channel: 'D1', channel_type: 'im', text: 'hi' })).toEqual([]);
    expect(directoryActions({ type: 'message', channel: 'C2', channel_type: 'mpim', text: 'hi' })).toEqual([]);
  });
});
