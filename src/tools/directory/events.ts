/**
 * Live directory updates from Slack events (routed by src/pipeline/slack-events.ts). user_change fires workspace-wide
 * on every profile or status change: it carries the whole profile, so it costs no Slack call, and a change to nothing
 * stored is a single upsert that writes nothing. Channel events update existing (public) rows; a new channel is
 * verified public with one conversations.info call before it's stored; a message arriving from a stored channel as a
 * private channel's (converted to private) removes its row.
 */
import { slackCall, slackErrorCode } from '../../core/slack.js';
import { log } from '../../log.js';
import { rememberChannelNotPublic } from '../slack-search.js';
import { channelFromSlack, directoryActions, type DirectoryAction } from './fields.js';
import { deleteChannel, updateChannel, upsertChannels, upsertPerson, type UpsertResult } from './store.js';

/** Apply one event's directory actions. Returns what happened (for tests and debug logs). */
export async function handleDirectoryEvent(ev: unknown): Promise<string[]> {
  const out: string[] = [];
  for (const a of directoryActions(ev)) out.push(await apply(a));
  return out;
}

async function apply(a: DirectoryAction): Promise<string> {
  switch (a.type) {
    case 'person': {
      const r: UpsertResult = await upsertPerson(a.person, { touch: false });
      if (r !== 'unchanged') log.debug({ userId: a.person.id, result: r }, 'directory person updated');
      return `person:${r}`;
    }
    case 'channel_refresh': {
      try {
        const res = await slackCall<any>('conversations.info', { channel: a.channelId, include_num_members: true }, { priority: 'background' });
        const ch = channelFromSlack(res.channel);
        if (!ch) return 'channel:not_public';
        await upsertChannels([ch], { touch: true });
        return 'channel:stored';
      } catch (err) {
        log.info({ err: slackErrorCode(err) ?? String(err), channel: a.channelId }, 'directory channel refresh failed');
        return 'channel:failed';
      }
    }
    case 'channel_renamed':
      return (await updateChannel(a.channelId, { name: a.name })) ? 'channel:renamed' : 'channel:unchanged';
    case 'channel_text':
      return (await updateChannel(a.channelId, { [a.field]: a.value })) ? `channel:${a.field}` : 'channel:unchanged';
    case 'channel_archived':
      return (await updateChannel(a.channelId, { isArchived: a.archived })) ? (a.archived ? 'channel:archived' : 'channel:unarchived') : 'channel:unchanged';
    case 'channel_deleted':
      return (await deleteChannel(a.channelId)) ? 'channel:deleted' : 'channel:unchanged';
    case 'channel_private': {
      // A public channel converted to private: out of the directory, and the cached "public" verdict of the
      // public-channel check (slack_search & co.) replaced, so it's dropped right away.
      if (!(await deleteChannel(a.channelId))) return 'channel:unchanged';
      await rememberChannelNotPublic(a.channelId).catch((err) => log.warn({ err, channel: a.channelId }, 'channel visibility cache update failed'));
      log.info({ channel: a.channelId }, 'directory: channel is private now; removed');
      return 'channel:private';
    }
  }
}
