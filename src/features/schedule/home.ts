/** App Home: the viewer's own pending reminders and active watches, with Cancel buttons (owner-only by query). */
import type { ActionContext } from '../../core/actions.js';
import { getUserInfo } from '../../context/users.js';
import { sql } from '../../db/index.js';
import { homeListBlocks, moreNote, registerHomeList } from '../home-lists.js';
import { mrkdwnEscape, truncate } from '../util.js';
import { reminderLabel, type ReminderRow } from './reminders.js';
import { formatInZone } from './time.js';
import { endWatch, watchLabel, type WatchRow } from './watches.js';

const INLINE = 3;
// A dialog shows at most this many of each (a modal holds 100 blocks).
const SHOWN = 45;

const btn = (action_id: string, value: string) => ({ type: 'button', action_id, text: { type: 'plain_text', text: 'Cancel' }, value });
const section = (text: string, accessory?: object) => ({ type: 'section', text: { type: 'mrkdwn', text }, ...(accessory ? { accessory } : {}) });

async function load(userId: string) {
  const [rems, watches, [counts]] = await Promise.all([
    sql<ReminderRow[]>`select id::int as id, text, due_at, channel_id from reminders where owner_id = ${userId} and status = 'pending' order by due_at limit ${SHOWN}`,
    sql<WatchRow[]>`select id::int as id, source, target, criteria, expires_at from watches where owner_id = ${userId} and status = 'active' order by id limit ${SHOWN}`,
    sql<{ rems: number; watches: number }[]>`
      select (select count(*)::int from reminders where owner_id = ${userId} and status = 'pending') as rems,
             (select count(*)::int from watches where owner_id = ${userId} and status = 'active') as watches`,
  ]);
  return { rems, watches, remCount: counts?.rems ?? rems.length, watchCount: counts?.watches ?? watches.length };
}

/** Every pending reminder and active watch (soonest reminder first), with Cancel buttons. */
async function itemBlocks(userId: string, d?: Awaited<ReturnType<typeof load>>): Promise<unknown[]> {
  const { rems, watches, remCount, watchCount } = d ?? (await load(userId));
  const tz = (await getUserInfo(userId).catch(() => null))?.tz;
  const out: unknown[] = [];
  for (const r of rems) out.push(section(`⏰ \`${reminderLabel(r.id)}\` *${formatInZone(r.dueAt, tz)}*\n${truncate(mrkdwnEscape(r.text), 600)}`, btn('sched:cancel_reminder', String(r.id))));
  out.push(...moreNote(remCount, rems.length));
  for (const w of watches)
    out.push(
      section(
        `👀 \`${watchLabel(w.id)}\` ${truncate(mrkdwnEscape(w.target), 300)}\n${truncate(mrkdwnEscape(w.criteria), 300)}\n_expires ${formatInZone(w.expiresAt, tz)}_`,
        btn('sched:cancel_watch', String(w.id)),
      ),
    );
  out.push(...moreNote(watchCount, watches.length));
  return out;
}

registerHomeList({ key: 'schedule', title: 'Reminders and watches', build: (userId) => itemBlocks(userId) });

export async function scheduleHomeBlocks(userId: string): Promise<unknown[]> {
  const d = await load(userId);
  const total = d.remCount + d.watchCount;
  if (total === 0) return [];
  const out: unknown[] = [{ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: 'Your reminders and watches' } }];
  const parts = [d.remCount && `*${d.remCount}* reminder${d.remCount === 1 ? '' : 's'}`, d.watchCount && `*${d.watchCount}* watch${d.watchCount === 1 ? '' : 'es'}`].filter(Boolean);
  if (total <= INLINE) out.push(...(await itemBlocks(userId, d)));
  else out.push(...homeListBlocks({ key: 'schedule', count: total, summary: `You have ${parts.join(' and ')}.` }));
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
