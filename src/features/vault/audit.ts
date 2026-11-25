/** Vault audit log (docs/vault.md): every use, approval and change, visible to the owner in App Home. */
import { sql } from '../../db/index.js';
import { log } from '../../log.js';

export type AuditOutcome = 'ok' | 'denied' | 'refused' | 'error' | 'approved' | 'expired' | 'requested';

export interface AuditRow {
  id: number;
  credentialName: string;
  action: string;
  tool: string | null;
  threadId: string | null;
  outcome: AuditOutcome;
  detail: Record<string, unknown>;
  at: Date;
}

export async function audit(o: {
  ownerId: string;
  credentialId?: string | null;
  credentialName: string;
  action: string;
  tool?: string | null;
  threadId?: string | null;
  outcome: AuditOutcome;
  /** Never a secret: host, path, command head, connector tool name… */
  detail?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    insert into vault_audit (owner_id, credential_id, credential_name, action, tool, thread_id, outcome, detail)
    values (${o.ownerId}, ${o.credentialId ?? null}, ${o.credentialName}, ${o.action}, ${o.tool ?? null}, ${o.threadId ?? null},
            ${o.outcome}, ${sql.json((o.detail ?? {}) as any)})`.catch((err) => log.warn({ err }, 'vault audit insert failed'));
}

export async function recentAudit(ownerId: string, limit = 8): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select id, credential_name, action, tool, thread_id, outcome, detail, at from vault_audit
    where owner_id = ${ownerId} order by at desc limit ${limit}`;
}

/** Retention: audit rows older than 90 days. */
export async function pruneAudit(): Promise<void> {
  await sql`delete from vault_audit where at < now() - interval '90 days'`;
  await sql`delete from vault_grants where expires_at < now()`;
  await sql`delete from vault_approvals where status <> 'pending' and created_at < now() - interval '7 days'`;
}
