/**
 * Web search = OpenRouter's `openrouter:web_search` SERVER tool. The installed `@openrouter/ai-sdk-provider`
 * (3.1.0) exposes it as a provider-defined tool, `openrouter.tools.webSearch({ engine, maxResults })`, which it
 * serialises to `{ type: 'openrouter:web_search', engine: 'auto', max_results: N }` in the chat request (verified
 * live with GPT-6 Luna, in both generateText and streamText). OpenRouter runs the search inside the model call:
 * there is no client-side execute and no tool-call/tool-result parts in the stream — results come back as
 * `source` parts (url citations) on the step, and usage reports `server_tool_use_details.web_search_requests`.
 *
 * So it's registered like any other tool (`toolsFor` returns it under the name `web_search`) — nothing else is
 * needed to ENABLE it. What the agent loop must add is ACCOUNTING (searches count towards per-user limits, and the
 * model decides to search server-side, so we can only count after the fact):
 *
 *   const meter = new WebSearchMeter();
 *   streamText({ ..., tools, includeRawChunks: true,            // raw chunks carry the per-step usage
 *     onChunk: ({ chunk }) => meter.observeChunk(chunk),
 *     onStepFinish: async (step) => { meter.observeStep(step); overLimit = await meter.settle(ctx) },
 *     prepareStep: () => overLimit ? { activeTools: allToolNames.filter((n) => n !== WEB_SEARCH_TOOL) } : {},
 *   });
 *
 * generateText: pass `include: { responseBody: true }` and call `meter.observeStep(step)` in onStepFinish — the
 * usage lives in the raw response body, which AI SDK v7 drops by default. (Without raw usage the meter falls back
 * to "≥1 search if the step has url sources".) The provider's providerMetadata.openrouter.usage does NOT carry it.
 * Also strip OpenAI-native citation markers from model text before posting it (`stripCitationMarkers`): with the
 * native engine, Luna sometimes leaves `citeturn0search2` tokens in its output.
 *
 * Note: the server tool can re-run on every step of a multi-step loop (observed live), so keep stopWhen tight.
 */
import { limits } from '../config.js';
import { openrouter } from '../models.js';
import { registerTool } from '../core/tools.js';
import { takeLimit } from '../features/guard.js';
import { log } from '../log.js';

export const WEB_SEARCH_TOOL = 'web_search';

export function webSearchTool() {
  return openrouter.tools.webSearch({ engine: 'auto', maxResults: limits.webSearchMaxResults });
}

registerTool({
  name: WEB_SEARCH_TOOL,
  roles: ['front', 'child'],
  build: () => webSearchTool(),
});

/** `web_search_requests` from an OpenRouter usage object (raw chunk or response body), if present. */
export function webSearchRequestsFromUsage(usage: any): number | undefined {
  const n = usage?.server_tool_use_details?.web_search_requests ?? usage?.serverToolUseDetails?.webSearchRequests;
  return typeof n === 'number' ? n : undefined;
}

/**
 * Counts server-side web searches per step and charges them to the speaker via `takeLimit('search')`.
 * Feed it raw chunks (streamText with includeRawChunks) and/or finished steps; call `settle` after each step.
 */
export class WebSearchMeter {
  private pendingFromChunks = 0;
  private sawChunkUsage = false;
  private pending = 0;
  total = 0;

  /** streamText `onChunk` / fullStream part. Only `raw` parts are inspected. */
  observeChunk(chunk: any) {
    if (chunk?.type !== 'raw') return;
    const n = webSearchRequestsFromUsage(chunk.rawValue?.usage);
    if (n !== undefined) {
      this.sawChunkUsage = true;
      this.pendingFromChunks += n;
    }
  }

  /** A finished step (`onStepFinish` arg or an element of `result.steps`). */
  observeStep(step: any) {
    let n: number | undefined;
    if (this.sawChunkUsage) n = this.pendingFromChunks;
    else n = webSearchRequestsFromUsage((step?.response?.body as any)?.usage);
    // Last resort: url citations imply at least one search happened.
    if (n === undefined) n = (step?.sources?.length ?? 0) > 0 ? 1 : 0;
    this.pending += n;
    this.pendingFromChunks = 0;
    this.sawChunkUsage = false;
  }

  /** Charge pending searches. Returns true if the user is now over their search limit (drop web_search from activeTools). */
  async settle(who: { speakerId: string; threadId?: string }): Promise<boolean> {
    let over = false;
    const n = this.pending;
    this.pending = 0;
    this.total += n;
    for (let i = 0; i < n; i++) {
      const msg = await takeLimit('search', who.speakerId, who.threadId);
      if (msg) over = true;
    }
    if (n) log.debug({ searches: n, speaker: who.speakerId }, 'web searches charged');
    return over;
  }
}

/** Remove OpenAI-native citation markers (e.g. `citeturn0search2turn0news1`) that can leak into model text. */
export function stripCitationMarkers(text: string): string {
  return text.replace(/\s??cite(?:?turn\d+[a-z]+\d+)+?/g, '').replace(/[-]/g, '');
}
