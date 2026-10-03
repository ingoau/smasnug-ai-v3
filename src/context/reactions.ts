// OWNER: tools/context module.
/**
 * Reactions on stored messages (`messages.reactions`): pure helpers to apply an add/remove and to normalise Slack's
 * `reactions` array. The DB update lives in reactions-store.ts.
 */
import type { MessageReaction } from '../core/types.js';

export type { MessageReaction } from '../core/types.js';

/** Slack API `reactions` ([{ name, users, count }]) → stored shape. */
export function reactionsFromSlack(raw: unknown): MessageReaction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r: any) => r && typeof r.name === 'string')
    .map((r: any) => {
      const users = Array.isArray(r.users) ? r.users.filter((u: unknown): u is string => typeof u === 'string') : [];
      return { name: r.name, users, count: Math.max(Number(r.count) || 0, users.length) };
    })
    .filter((r) => r.count > 0);
}

/** Apply one reaction_added / reaction_removed. Idempotent per (user, name); order of first appearance is kept. */
export function applyReaction(list: MessageReaction[], op: 'added' | 'removed', name: string, user: string): MessageReaction[] {
  const out = list.map((r) => ({ ...r, users: [...r.users] }));
  const i = out.findIndex((r) => r.name === name);
  if (op === 'added') {
    if (i < 0) return [...out, { name, users: [user], count: 1 }];
    const r = out[i]!;
    if (r.users.includes(user)) return out;
    r.users.push(user);
    r.count = Math.max(r.count + 1, r.users.length);
    return out;
  }
  if (i < 0) return out;
  const r = out[i]!;
  if (!r.users.includes(user)) return out;
  r.users = r.users.filter((u) => u !== user);
  r.count = Math.max(r.count - 1, r.users.length);
  return r.count > 0 ? out : out.filter((_, j) => j !== i);
}
