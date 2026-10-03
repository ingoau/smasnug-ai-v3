/**
 * `ToolContext.extras` keys read by the tools module. The agent module SETS these when building a role's tools
 * (`toolsFor(role, { ..., extras: { [EXTRAS.defaultReactTs]: ts, ... } })`); the tools module only reads them.
 */
export const EXTRAS = {
  /**
   * `string` — the turn's latest triggering message ts. `react` targets it when the model omits `message_ts`.
   * Set it for every front turn (for synthesis turns: the message that started the card, or leave unset).
   */
  defaultReactTs: 'defaultReactTs',
  /**
   * `QueueUserImage` — OPTIONAL fallback for models that reject images inside tool results. When set, `read_image`
   * does not return the image as a tool-result part; it calls this function and returns "image loaded" text. The
   * agent loop must then append the queued images as a user message (image parts) before the next model step,
   * e.g. in `prepareStep`. Leave it UNSET for GPT-6 Luna: images in tool results were verified to work live.
   */
  queueUserImage: 'queueUserImage',
} as const;

export interface QueuedImage {
  /** The thread-scoped id the model asked for, e.g. 'img_3'. */
  id: string;
  /** Image MIME type after processing: 'image/jpeg' | 'image/png'. */
  mediaType: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
}

export type QueueUserImage = (image: QueuedImage) => void | Promise<void>;

/** Typed view of the extras the tools module understands. */
export interface ToolsExtras {
  [EXTRAS.defaultReactTs]?: string;
  [EXTRAS.queueUserImage]?: QueueUserImage;
}

export function getExtra<K extends keyof ToolsExtras>(extras: Record<string, unknown>, key: K): ToolsExtras[K] | undefined {
  return extras[key] as ToolsExtras[K] | undefined;
}
