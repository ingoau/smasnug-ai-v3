/** Pure parts of the coding-agent launch confirmation (confirm.ts): click decisions and the preview blocks. */

export interface PendingLaunchRow {
  id: string;
  threadId: string;
  ownerId: string;
  title: string;
  instructions: string;
  status: string; // pending | launching | launched | cancelled | expired | failed
  subagentId: string | null;
  expiresAt: Date;
}

export type LaunchDecision = 'ok' | 'not_found' | 'wrong_user' | 'expired' | 'launched' | 'launching' | 'cancelled' | 'failed';

/** What a click on Launch / Cancel should do. Only the admin who asked (owner = ADMIN_USER_ID) may press them. */
export function decideLaunchClick(
  p: Pick<PendingLaunchRow, 'ownerId' | 'status' | 'expiresAt'> | undefined,
  clickerId: string,
  adminId: string | undefined,
  now = new Date(),
): LaunchDecision {
  if (!p) return 'not_found';
  if (!adminId || clickerId !== adminId || clickerId !== p.ownerId) return 'wrong_user';
  if (p.status === 'launched') return 'launched';
  if (p.status === 'launching') return 'launching';
  if (p.status === 'cancelled') return 'cancelled';
  if (p.status === 'failed') return 'failed';
  if (p.status !== 'pending' || p.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'ok';
}

export const LAUNCH_CLICK_REPLIES: Record<Exclude<LaunchDecision, 'ok'>, { text: string; replace: boolean }> = {
  not_found: { text: 'This expired. Ask again to start a coding agent.', replace: true },
  expired: { text: 'This expired. Ask again to start a coding agent.', replace: true },
  wrong_user: { text: "Only the bot's admin can launch or cancel this.", replace: false },
  launched: { text: 'Already launched.', replace: true },
  launching: { text: 'Launching…', replace: false },
  cancelled: { text: 'Cancelled. Nothing was started.', replace: true },
  failed: { text: "This launch failed. Ask again to retry.", replace: true },
};

/**
 * What happened to a proposed launch, for the agent's outcome turn (src/features/outcome-turn.ts). A successful launch
 * has none: its plan card and later synthesis cover it.
 */
export type LaunchOutcome = { kind: 'cancelled' } | { kind: 'failed'; error: string } | { kind: 'expired'; ttlMin: number };

/** The admin acted (Cancel, a failed Launch): treat it like a mention. Expiry: the agent may stay silent. */
export const launchOutcomeIsMention = (o: LaunchOutcome) => o.kind !== 'expired';

/** Posted by code if the outcome turn ends with nothing visible or fails (Cancel already showed its ephemeral). */
export const launchOutcomeFallback = (o: LaunchOutcome): string | null => (o.kind === 'failed' ? `not launched: ${o.error}` : null);

/** The input of the outcome turn: a system notice, not the admin's words. */
export function renderLaunchOutcome(o: { pendingId: string; ownerId: string; title: string; outcome: LaunchOutcome }): string {
  const who = `<@${o.ownerId}>`;
  const title = o.title.replace(/["<>]/g, '');
  const out = o.outcome;
  const notice =
    out.kind === 'cancelled'
      ? `${who} clicked Cancel on the launch preview for the coding agent "${title}", so nothing was started. Acknowledge it in a few words (e.g. "ok, cancelled"), or ask what to change if that's clearly useful.`
      : out.kind === 'failed'
        ? `${who} clicked Launch on the coding agent "${title}", but it could not start (${out.error.replace(/[<>]/g, '')}). Tell them briefly.`
        : `Nobody clicked Launch or Cancel on the preview for the coding agent "${title}" within ${out.ttlMin} min, so it expired and nothing was started. If the conversation has moved on, stay silent (call end_turn without replying); otherwise at most one short line that it wasn't started and they can ask again.`;
  return [
    `<coding_agent_outcome id="${o.pendingId}" status="${out.kind}" title="${title}"/>`,
    `System notice (not a message from ${who}): this turn reports what happened to a coding agent you proposed with spawn_coding_agent earlier in this thread. ${notice} Don't propose it again unless they ask.`,
  ].join('\n');
}

/** Section text limit (https://docs.slack.dev/reference/block-kit/blocks/section-block: max 3000 characters). */
const SECTION_MAX = 3000;
/** Longest task the preview can show in full (plain-text sections within the 50-block limit). */
export const CODING_INSTRUCTIONS_MAX = 12_000;

/** Split text into chunks of at most `max` characters, preferring line breaks. */
export function chunkText(text: string, max = SECTION_MAX - 100): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The ephemeral preview: the title and the task exactly as they will be sent (plain_text, so Slack formatting can't
 * hide or alter anything), the fixed rules code adds, and Launch / Cancel.
 */
export function launchPreviewBlocks(o: { pendingId: string; title: string; instructions: string; repoUrl: string; ref: string; ttlMin: number }): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Launch a coding agent?* Only you can see this. It works on ${o.repoUrl} (from \`${o.ref}\`) and opens a pull request. Nothing starts until you press Launch (expires in ${o.ttlMin} min).`,
      },
    },
    { type: 'section', text: { type: 'plain_text', text: `Title: ${o.title}`.slice(0, SECTION_MAX), emoji: false } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Task, exactly as it will be sent:' }] },
    ...chunkText(o.instructions).map((t) => ({ type: 'section', text: { type: 'plain_text', text: t, emoji: false } })),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Code adds the fixed rules: follow CLAUDE.md, no CI or repo-policy changes, tests, self-review, PR only.' }],
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'coding:launch', text: { type: 'plain_text', text: 'Launch' }, style: 'primary', value: o.pendingId },
        { type: 'button', action_id: 'coding:cancel', text: { type: 'plain_text', text: 'Cancel' }, value: o.pendingId },
      ],
    },
  ];
}
