/**
 * Ephemeral mode intake (`@bot !p …`, guidelines.ts rule 5; delivery in src/agent/private-reply.ts): the request skips
 * the debounce batch and gets a private turn of its own (scheduler.requestTurn `ephemeral`), never merged with the
 * author's other messages or pushed into a running turn. A short ephemeral ack goes out right away, since a private
 * turn shows no status indicator (the session status is visible to everyone).
 */
import { appendEvent, parseThreadId, threadTsArg } from '../core/events.js';
import { slackCall } from '../core/slack.js';
import { markMessage } from '../core/timing.js';
import { log } from '../log.js';
import { requestTurn } from './scheduler.js';

export const PRIVATE_ACK_TEXT = '_On it. Only you will see the answer._';

export async function startPrivateTurn(o: { threadId: string; authorId: string; ts: string }): Promise<number> {
  const { channelId, threadTs } = parseThreadId(o.threadId);
  // A question in a thread is answered in it; a top-level one at the channel root next to it (private-reply.ts).
  const ackThreadTs = o.ts !== threadTs ? threadTs : undefined;
  await slackCall('chat.postEphemeral', { channel: channelId, user: o.authorId, text: PRIVATE_ACK_TEXT, ...threadTsArg(ackThreadTs) }, { idempotencyKey: `private-ack:${channelId}:${o.ts}` }).catch(
    (err) => log.warn({ err, threadId: o.threadId }, 'private ack failed'),
  );
  const turnId = await requestTurn({ threadId: o.threadId, authorId: o.authorId, kind: 'user', ephemeral: true, isMention: true, messageTs: [o.ts] });
  markMessage(channelId, o.ts, { turn_created: Date.now() });
  await appendEvent(o.threadId, 'private_request', o.authorId, { ts: o.ts, turnId });
  return turnId;
}
