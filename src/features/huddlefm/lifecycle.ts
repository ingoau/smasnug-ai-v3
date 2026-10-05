/** DJ mode ending: the session row goes and the origin thread hears why (exactly once, see notices.ts). */
import type { TransactionSql } from 'postgres';
import { sql } from '../../db/index.js';
import { announce } from './notices.js';
import type { DjSession } from './store.js';

type Tx = TransactionSql<{}>;

/** Delete exactly this session (a newer request for the same channel is a different row generation). */
export async function deleteSessionTx(tx: Tx, s: Pick<DjSession, 'id'>, status?: DjSession['status']): Promise<boolean> {
  const rows = status
    ? await tx`delete from dj_sessions where id = ${s.id} and status = ${status} returning id`
    : await tx`delete from dj_sessions where id = ${s.id} returning id`;
  return rows.length > 0;
}

/** A command failed with a lost-grant error (HuddleFM restarted, session gone): DJ mode is over. */
export async function grantLost(s: DjSession, error: string): Promise<void> {
  const where = `<#${s.channelId}>`;
  await announce({
    threadId: s.originThreadId,
    speakerId: s.requestedBy,
    ref: `lost:${s.id}`,
    what: `You lost control of the music in ${where}: HuddleFM answered "${error}". That usually means the HuddleFM session ended or HuddleFM restarted (grants don't survive a restart). DJ mode is off there now.`,
    how: 'Tell the thread in one short reply and offer to ask the host again. Then end your turn.',
    fallback: `lost the aux in ${where} (the huddlefm session ended or restarted), so dj mode is off. ask me again if you want me back`,
    important: true,
    transition: (tx) => deleteSessionTx(tx, s, 'active'),
  });
}

/** Ended without a notice (the user turned it off themselves): just the row. */
export async function deleteSession(s: Pick<DjSession, 'id'>): Promise<boolean> {
  return sql.begin((tx) => deleteSessionTx(tx, s));
}
