/**
 * Workspace AI-bot guidelines (design doc, "When the bot responds"). Pure detection helpers, no I/O, operating on
 * the raw Slack message text (mrkdwn: mentions are `<@U…>`, a literal `<` / `>` arrives as `&lt;` / `&gt;`).
 *
 * 1. `##` prefix: the message is ignored completely (never stored, never triggers anything, hidden from every read).
 * 2. `@bot !stop`: stop the current response (stop.ts; there is no native stop button).
 * 3. A top-level channel message that pings a group (user group, @channel/@here/@everyone) and triggers the bot: the
 *    bot answers in a new top-level message instead of replying under the group ping.
 * 4. `<>` prefix: never triggers a turn or the gate unless the bot is @mentioned (still stored and visible).
 */

const lead = (text: string | null | undefined) => (text ?? '').trimStart();

/** Rule 1: text (trimmed) starts with `##`. Such messages must be invisible to the bot. */
export function isHiddenMessage(text: string | null | undefined): boolean {
  return lead(text).startsWith('##');
}

/** Rule 4: text (trimmed) starts with a literal `<>` (raw or entity-escaped, e.g. `&lt;&gt;`). */
export function hasQuietPrefix(text: string | null | undefined): boolean {
  return /^(?:<|&lt;)(?:>|&gt;)/.test(lead(text));
}

const GROUP_PING = /<!(?:subteam\^[A-Z0-9]+|channel|here|everyone)(?:\|[^>]*)?>/i;

/** Rule 3: the text pings a user group or the whole channel (`<!subteam^S…>`, `<!channel>`, `<!here>`, `<!everyone>`). */
export function hasGroupPing(text: string | null | undefined): boolean {
  return GROUP_PING.test(text ?? '');
}

/**
 * Rule 2: `@bot !stop` (case-insensitive, any whitespace). Every bot mention is removed and the rest must be exactly
 * `!stop`. In DMs the mention is optional (the whole conversation is addressed to the bot).
 */
export function isBangStop(text: string | null | undefined, botUserId: string, opts: { isDm?: boolean } = {}): boolean {
  const raw = text ?? '';
  const botMention = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g');
  const mentioned = botMention.test(raw);
  if (!mentioned && !opts.isDm) return false;
  return /^!stop$/i.test(raw.replace(botMention, ' ').trim());
}

/**
 * Rule 3: the triggering message is a top-level channel message (not a thread reply, not a DM) that pings a group:
 * the bot must not reply under it.
 */
export function shouldRedirectGroupPing(f: { isDm: boolean; threadTs?: string; ts: string; mentionsBot: boolean; text: string | null | undefined }): boolean {
  if (f.isDm || !f.mentionsBot) return false;
  if (f.threadTs && f.threadTs !== f.ts) return false;
  return hasGroupPing(f.text);
}

/** Group pings neutralised (zero-width space after `@`) so text the bot posts can never notify a group. */
export function neutralizeBroadcasts(text: string): string {
  return text
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/gi, '@​$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/gi, (_m, label?: string) => `@​${String(label ?? 'group').replace(/^@/, '')}`)
    .replace(/(^|[^\w​])@(here|channel|everyone)\b/gi, '$1@​$2');
}

/**
 * For streamed text: the neutralised prefix that can't change once more text arrives. A trailing `<!…` without its
 * closing `>`, or a trailing `@word`, is held back (it may still become a group ping).
 */
export function broadcastSafePrefix(partial: string): string {
  let s = partial;
  const open = s.lastIndexOf('<!');
  if (open >= 0 && !s.slice(open).includes('>')) s = s.slice(0, open);
  else if (s.endsWith('<')) s = s.slice(0, -1);
  const at = /@\w*$/.exec(s);
  if (at) s = s.slice(0, at.index);
  return neutralizeBroadcasts(s);
}

/** Text of the new top-level message posted instead of replying under a group ping (rule 3). Pings nobody but the asker. */
export function groupRedirectText(userId: string, permalink: string | undefined): string {
  const where = permalink ? `<${permalink}|this message>` : 'a message above';
  return `<@${userId}> asked me something in ${where}, replying here so the group thread stays clean.`;
}
