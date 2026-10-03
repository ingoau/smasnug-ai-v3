// OWNER: pipeline module. Ingress process: Socket Mode, ack, dedupe, enqueue. Never calls a model.
import { SocketModeClient } from '@slack/socket-mode';
import { env } from '../config.js';
import { closeQueues, enqueue, QUEUE } from '../core/queues.js';
import { redis } from '../core/redis.js';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import type { SlackEnvelopeJob } from '../pipeline/slack-events.js';

interface SocketEvent {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  envelope_id: string;
  type: string;
  body: any;
  retry_num?: number;
  retry_reason?: string;
}

const KIND: Record<string, SlackEnvelopeJob['kind']> = { events_api: 'event', interactive: 'interactive', slash_commands: 'slash' };

/** Dedupe key: Events API retries carry the same event_id (with a higher retry_attempt); others use the envelope id. */
export function dedupeKey(e: Pick<SocketEvent, 'type' | 'envelope_id' | 'body'>): string {
  if (e.type === 'events_api' && e.body?.event_id) return String(e.body.event_id);
  return `env:${e.envelope_id}`;
}

/** Returns true the first time a key is seen. */
export async function claimEvent(key: string): Promise<boolean> {
  const rows = await sql`insert into slack_events_seen (event_id) values (${key}) on conflict do nothing returning event_id`;
  return rows.length > 0;
}

export async function handleEnvelope(e: SocketEvent) {
  const kind = KIND[e.type];
  if (!kind) return;
  const key = dedupeKey(e);
  if (!(await claimEvent(key))) {
    log.info({ key, retry: e.retry_num, reason: e.retry_reason }, 'duplicate envelope dropped');
    return;
  }
  try {
    await enqueue(QUEUE.slackEvents, { kind, body: e.body } satisfies SlackEnvelopeJob, { jobId: `se-${key.replaceAll(':', '_')}` });
  } catch (err) {
    // Already acked, so Slack won't retry; free the key so a manual replay isn't swallowed.
    await sql`delete from slack_events_seen where event_id = ${key}`.catch(() => {});
    throw err;
  }
}

async function main() {
  if (!env.SLACK_APP_TOKEN) throw new Error('SLACK_APP_TOKEN is required for ingress');
  const client = new SocketModeClient({ appToken: env.SLACK_APP_TOKEN });
  let inflight = 0;

  client.on('slack_event', async (e: SocketEvent) => {
    // Ack first, always: never risk Slack's 3-second window. Responses (e.g. view errors) are not supported.
    try {
      await e.ack();
    } catch (err) {
      log.warn({ err, envelope: e.envelope_id }, 'ack failed');
    }
    inflight++;
    try {
      await handleEnvelope(e);
    } catch (err) {
      log.error({ err, type: e.type, envelope: e.envelope_id }, 'failed to enqueue envelope');
    } finally {
      inflight--;
    }
  });
  client.on('connected', () => log.info('socket mode connected'));
  client.on('disconnected', () => log.warn('socket mode disconnected'));

  await client.start();
  log.info('ingress started');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'ingress shutting down');
    try {
      await client.disconnect();
      const deadline = Date.now() + 5_000;
      while (inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await closeQueues();
      await redis.quit();
      await sql.end({ timeout: 5 });
    } catch (err) {
      log.error({ err }, 'error during ingress shutdown');
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error({ err }, 'ingress failed');
    process.exit(1);
  });
}
