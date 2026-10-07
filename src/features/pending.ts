// OWNER: features module.
/**
 * The speaker's pending actions for the front agent's turn message (<pending_actions>): send_message previews
 * waiting for their Send click, coding-agent previews not launched yet, live previews waiting for them to accept
 * Cloudflare's terms or still claimable, and how many reminders / watches they have running. Read-only queries
 * over the features / agent / sandbox tables; empty when there's nothing.
 */
import { sql } from '../db/index.js';

export interface PendingActions {
  /** send_message previews awaiting this user's confirmation: destination channel / user id. */
  sends: { destination: string; expiresAt: Date }[];
  /** Coding-agent launch previews not launched yet (titles). */
  codingAgents: string[];
  reminders: number;
  watches: number;
  /** Live previews waiting for the user to accept Cloudflare's terms. */
  previewTerms: number;
  /** Live previews the user can still claim. */
  previewClaims: number;
}

export async function loadPendingActions(userId: string): Promise<PendingActions> {
  const [sends, coding, counts] = await Promise.all([
    sql<{ destination: string; expiresAt: Date }[]>`
      select destination, expires_at from pending_sends where requester_id = ${userId} and status = 'pending' and expires_at > now()
      order by created_at limit 5`,
    sql<{ title: string }[]>`
      select title from pending_coding_agents where owner_id = ${userId} and status = 'pending' and expires_at > now() order by created_at limit 5`,
    sql<{ reminders: number; watches: number; previewTerms: number; previewClaims: number }[]>`
      select
        (select count(*)::int from reminders where owner_id = ${userId} and status in ('pending', 'firing')) as reminders,
        (select count(*)::int from watches where owner_id = ${userId} and status = 'active' and expires_at > now()) as watches,
        (select count(*)::int from previews where requester_id = ${userId} and status = 'awaiting_terms') as preview_terms,
        (select count(*)::int from previews where requester_id = ${userId} and status = 'live' and claim_url_enc is not null and claim_expires_at > now()) as preview_claims`,
  ]);
  const c = counts[0];
  return {
    sends: sends.map((s) => ({ destination: s.destination, expiresAt: new Date(s.expiresAt) })),
    codingAgents: coding.map((r) => r.title),
    reminders: c?.reminders ?? 0,
    watches: c?.watches ?? 0,
    previewTerms: c?.previewTerms ?? 0,
    previewClaims: c?.previewClaims ?? 0,
  };
}

const where = (id: string) => (/^[UW]/.test(id) ? `<@${id}>` : `<#${id}>`);
const mins = (until: Date, now: Date) => Math.max(1, Math.round((until.getTime() - now.getTime()) / 60_000));

/** Pure: the <pending_actions> body, one compact line per kind; '' when nothing is pending. */
export function renderPendingActions(p: PendingActions, now = new Date()): string {
  const lines: string[] = [];
  if (p.sends.length)
    lines.push(`send_message previews waiting for their Send click (nothing sent yet): ${p.sends.map((s) => `to ${where(s.destination)}, expires in ${mins(s.expiresAt, now)} min`).join('; ')}`);
  if (p.codingAgents.length) lines.push(`Coding-agent previews not launched yet (they press Launch): ${p.codingAgents.map((t) => `"${t.replace(/["<>\n]/g, ' ').slice(0, 60)}"`).join(', ')}`);
  if (p.previewTerms) lines.push(`Live previews waiting for them to accept Cloudflare's terms (in the ephemeral prompt): ${p.previewTerms}`);
  if (p.previewClaims) lines.push(`Live previews they can still claim (Get claim link button): ${p.previewClaims}`);
  const running = [p.reminders ? `${p.reminders} ${p.reminders === 1 ? 'reminder' : 'reminders'}` : '', p.watches ? `${p.watches} ${p.watches === 1 ? 'watch' : 'watches'}` : ''].filter(Boolean);
  if (running.length) lines.push(`Active: ${running.join(', ')} (list_reminders / list_watches for details)`);
  return lines.join('\n');
}
