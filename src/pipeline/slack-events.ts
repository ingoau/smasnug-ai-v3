/** slack-events processor: routes raw envelopes enqueued by ingress. */
import type { Job } from 'bullmq';
import { log } from '../log.js';
import { handleAppHomeOpened, handleInteractive, handleSlash } from './interactions.js';
import { handleMessageEvent } from './intake.js';
import { handleAgentSessionStopped } from './stop.js';
import { handleAppContextChanged } from './view-context.js';

export interface SlackEnvelopeJob {
  kind: 'event' | 'interactive' | 'slash';
  /** events: the Events API payload ({ event, event_id, … }); interactive/slash: the payload as delivered. */
  body: any;
}

export async function processSlackEvent(job: Job<SlackEnvelopeJob>) {
  const { kind, body } = job.data;
  switch (kind) {
    case 'event': {
      const event = body?.event;
      switch (event?.type) {
        case 'message':
          return handleMessageEvent(event);
        case 'app_home_opened':
          return handleAppHomeOpened(event);
        case 'agent_session_stopped':
          return handleAgentSessionStopped(event);
        case 'app_context_changed':
          return handleAppContextChanged(body); // user is in body.authorizations
        case 'agent_session_title_changed':
          log.info({ channel: event.channel, threadTs: event.thread_ts, title: event.title }, 'agent session title changed');
          return;
        case 'app_mention':
          return; // duplicates the `message` event, which is what triggers turns
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
