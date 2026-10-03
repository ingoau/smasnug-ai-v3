/** Relevance gate: a cheap yes/no model call for unmentioned follow-ups in engaged threads. No tools. */
import { generateText } from 'ai';
import { env, limits } from '../config.js';
import { openrouter, MODELS } from '../models.js';
import type { StoredMessage } from '../core/types.js';
import { gateSystemPrompt, gateUserPrompt } from './gate-prompt.js';

export interface GateResult {
  respond: boolean;
  raw: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

/** Reasoning off for the gate. Verified live: `effort: 'none'` → 0 reasoning tokens, ~1s latency. */
export const GATE_PROVIDER_OPTIONS = { openrouter: { reasoning: { effort: 'none' } } } as const;

/** Compact plain rendering for the gate (the full context renderer belongs to the context module). */
export function renderForGate(msgs: StoredMessage[], botUserId: string, botName = env.BOT_DISPLAY_NAME): string {
  return msgs
    .map((m) => {
      const who = m.botId ? (m.userId === botUserId || !m.userId ? `${botName} (bot)` : `${m.username ?? m.userId} (bot)`) : `<@${m.userId}>`;
      let text = m.text.replaceAll(`<@${botUserId}>`, `@${botName}`);
      if (text.length > 1200) text = `${text.slice(0, 1200)}…`;
      const files = m.files.length ? ` [${m.files.length} file(s)]` : '';
      return `${who}: ${text}${files}`;
    })
    .join('\n');
}

export function parseGateAnswer(text: string): boolean {
  const first = text.trim().toLowerCase().replace(/^[^a-z]+/, '');
  return first.startsWith('yes');
}

export async function runGate(opts: { context: StoredMessage[]; newMessages: StoredMessage[]; botUserId: string; abortSignal?: AbortSignal }): Promise<GateResult> {
  const started = Date.now();
  try {
    const res = await generateText({
      model: openrouter(MODELS.gate),
      system: gateSystemPrompt(env.BOT_DISPLAY_NAME),
      prompt: gateUserPrompt({
        context: renderForGate(opts.context.slice(-limits.gateContextMessages), opts.botUserId),
        newMessages: renderForGate(opts.newMessages, opts.botUserId),
      }),
      providerOptions: GATE_PROVIDER_OPTIONS as any,
      maxOutputTokens: 16,
      temperature: 0,
      maxRetries: 1,
      abortSignal: opts.abortSignal ?? AbortSignal.timeout(15_000),
    });
    return {
      respond: parseGateAnswer(res.text),
      raw: res.text,
      latencyMs: Date.now() - started,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
    };
  } catch (err) {
    // Fail quiet: an outage should not make the bot butt into conversations.
    return { respond: false, raw: '', latencyMs: Date.now() - started, error: (err as Error).message };
  }
}
