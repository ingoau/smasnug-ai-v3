/** App Home: the viewer's own pending reminders and active watches, with Cancel buttons (owner-only by query). */
import type { ActionContext } from '../../core/actions.js';
import { getUserInfo } from '../../context/users.js';
import { sql } from '../../db/index.js';
import { mrkdwnEscape, truncate } from '../util.js';
import { reminderLabel, type ReminderRow } from './reminders.js';
import { formatInZone } from './time.js';
import { endWatch, watchLabel, type WatchRow } from './watches.js';

const SHOWN = 10;

const btn = (action_id: string, value: string) => ({ type: 'button', action_id, text: { type: 'plain_text', text: 'Cancel' }, value });
const section = (text: string, accessory?: object) => ({ type: 'section', text: { type: 'mrkdwn', text }, ...(accessory ? { accessory } : {}) });
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

export async function scheduleHomeBlocks(userId: string): Promise<unknown[]> {
  const [rems, watches] = await Promise.all([
    sql<ReminderRow[]>`select id::int as id, text, due_at, channel_id from reminders where owner_id = ${userId} and status = 'pending' order by due_at limit ${SHOWN + 1}`,
    sql<WatchRow[]>`select id::int as id, source, target, criteria, expires_at from watches where owner_id = ${userId} and status = 'active' order by id limit ${SHOWN + 1}`,
  ]);
  if (!rems.length && !watches.length) return [];
  const tz = (await getUserInfo(userId).catch(() => null))?.tz;
  const out: unknown[] = [{ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: 'Your reminders and watches' } }];
  for (const r of rems.slice(0, SHOWN))
    out.push(section(`⏰ \`${reminderLabel(r.id)}\` *${formatInZone(r.dueAt, tz)}*\n${truncate(mrkdwnEscape(r.text), 600)}`, btn('sched:cancel_reminder', String(r.id))));
  if (rems.length > SHOWN) out.push(context('…and more reminders. Ask me "list my reminders" to see them all.'));
  for (const w of watches.slice(0, SHOWN))
    out.push(
      section(
        `👀 \`${watchLabel(w.id)}\` ${truncate(mrkdwnEscape(w.target), 300)}\n${truncate(mrkdwnEscape(w.criteria), 300)}\n_expires ${formatInZone(w.expiresAt, tz)}_`,
        btn('sched:cancel_watch', String(w.id)),
      ),
    );
  return out;
}

/** sched:cancel_reminder / sched:cancel_watch — only the clicking user's own items are touched. */
export async function handleScheduleAction(ctx: ActionContext, publishHome: (userId: string) => Promise<void>) {
  const id = Number(ctx.value);
  if (Number.isSafeInteger(id) && id > 0) {
    if (ctx.actionId === 'sched:cancel_reminder')
      await sql`update reminders set status = 'cancelled', updated_at = now() where id = ${id} and owner_id = ${ctx.userId} and status = 'pending'`;
    else if (ctx.actionId === 'sched:cancel_watch') await endWatch(id, ctx.userId, 'cancelled');
  }
  await publishHome(ctx.userId);
}
