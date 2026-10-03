/**
 * ToolContext.extras keys set by the agent module (front agent and children). Other modules' tools may read them.
 *
 * - `defaultReactTs: string` (front only) — ts of the speaker's latest message in this turn; updated in place when
 *   inbox messages are injected, so read it at execute time (`ctx.extras.defaultReactTs`), not at build time.
 * - `queueUserImage: (img: QueuedImage) => void` (front + children) — fallback for models that can't take images
 *   in tool results: the loop appends queued images as a user message before the next model call.
 * - `agentTurn` (front only, internal) — the agent module's per-turn state used by reply/spawn/etc.
 */
export interface QueuedImage {
  /** Raw bytes or base64 string. */
  data: Uint8Array | string;
  mediaType: string;
  /** Short label shown next to the image, e.g. "img_3: screenshot.png". */
  caption?: string;
}

export type QueueUserImage = (img: QueuedImage) => void;
