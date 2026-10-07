/** slack-events processor: routes raw envelopes enqueued by ingress. */
import type { Job } from 'bullmq';
import { log } from '../log.js';
import { markMessage } from '../core/timing.js';
import { handleAppHomeOpened, handleInteractive, handleSlash } from './interactions.js';
import { handleMessageEvent } from './intake.js';
import { handleReactionEvent } from './reactions.js';
import { handleAgentSessionStopped } from './stop.js';
import { handleSessionTitleChanged } from './agent-session.js';
import { handleAppContextChanged } from './view-context.js';
import { handleDirectoryEvent } from '../tools/directory/events.js';

export interface SlackEnvelopeJob {
  kind: 'event' | 'interactive' | 'slash';
  /** events: the Events API payload ({ event, event_id, … }); interactive/slash: the payload as delivered. */
  body: any;
  /** Epoch ms when ingress received the envelope (latency instrumentation). */
  receivedAt?: number;
}

export async function processSlackEvent(job: Job<SlackEnvelopeJob>) {
  const { kind, body } = job.data;
  switch (kind) {
    case 'event': {
      const event = body?.event;
      switch (event?.type) {
        case 'message':
          if (!event.subtype && event.channel && event.ts) markMessage(event.channel, event.ts, { intake_start: Date.now() });
          // Topic / purpose / name changes in public channels the bot is in: the directory row too.
          // A message from a C… channel as a private channel's: converted from public, so out of the directory
          // (one primary-key delete that usually matches nothing).
          if (event.subtype === 'channel_topic' || event.subtype === 'channel_purpose' || event.subtype === 'channel_name' || (event.channel_type === 'group' && String(event.channel ?? '').startsWith('C'))) {
            await handleDirectoryEvent(event).catch((err) => log.warn({ err }, 'directory channel update failed'));
          }
          return handleMessageEvent(event);
        case 'app_home_opened':
          return handleAppHomeOpened(event);
        case 'agent_session_stopped':
          // Not subscribed any more (no native stop button, slack-manifest.yml); kept for an app still on an old manifest.
          return handleAgentSessionStopped(event);
        case 'app_context_changed':
          return handleAppContextChanged(body); // user is in body.authorizations
        case 'agent_session_title_changed':
          return handleSessionTitleChanged(event); // a user's title is never overwritten (DMs)
        case 'reaction_added':
        case 'reaction_removed':
          return handleReactionEvent(event);
        case 'app_mention':
          return; // duplicates the `message` event, which is what triggers turns
        // Workspace directory (src/tools/directory/): profile and public-channel changes.
        case 'user_change':
        case 'team_join':
        case 'channel_created':
        case 'channel_rename':
        case 'channel_archive':
        case 'channel_unarchive':
        case 'channel_deleted':
          await handleDirectoryEvent(event);
          return;
        default:
          log.debug({ type: event?.type }, 'ignoring event');
          return;
      }
    }
    case 'interactive':
      return handleInteractive(body);
    case 'slash':
      return handleSlash(body);
  }
}
