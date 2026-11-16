/**
 * Parent-agent posts into a code channel (docs/code-channels.md, Parent link: `message_code_channel`). The parent
 * thread's agent posts as the bot under a distinct identity (`chat:write.customize`) and marks the post with message
 * metadata. Intake (src/pipeline/intake.ts) takes a top-level bot post carrying this marker in a code channel as an
 * instruction from the requester: stored, recorded as a `parent_message` event, and a turn for `${channel}:0`
 * attributed to the requester (batch reason 'parent', no gate). Every other bot post stays ignored.
 *
 * Only the bot itself can post messages with its own bot_id, so the marker can't be forged by other apps or people;
 * intake also checks the payload's parent thread against the channel's `code_channels` row.
 */

/** `metadata.event_type` of a parent post. */
export const PARENT_MESSAGE_EVENT_TYPE = 'smasnug_parent_message';

export interface ParentMessageMarker {
  /** The parent thread the post came from (must be the channel's `code_channels.parent_thread_id`). */
  parentThreadId: string;
  /** Who the instruction is from: the turn in the channel is attributed to them. */
  requesterId: string;
}

/** The `metadata` arg for chat.postMessage (stage 3's message_code_channel). */
export function parentMessageMetadata(m: ParentMessageMarker): { event_type: string; event_payload: ParentMessageMarker } {
  return { event_type: PARENT_MESSAGE_EVENT_TYPE, event_payload: { parentThreadId: m.parentThreadId, requesterId: m.requesterId } };
}

/** The marker of a Slack message (its `metadata`), or null when it isn't a parent post. Pure. */
export function parseParentMessage(msg: { metadata?: unknown }): ParentMessageMarker | null {
  const md = msg.metadata as { event_type?: unknown; event_payload?: { parentThreadId?: unknown; requesterId?: unknown } } | undefined;
  if (!md || md.event_type !== PARENT_MESSAGE_EVENT_TYPE) return null;
  const { parentThreadId, requesterId } = md.event_payload ?? {};
  if (typeof parentThreadId !== 'string' || !parentThreadId || typeof requesterId !== 'string' || !/^[UW][A-Z0-9]+$/.test(requesterId)) return null;
  return { parentThreadId, requesterId };
}
