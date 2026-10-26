/**
 * Privacy consent end to end through intake and the interaction dispatcher (fake Slack, dedicated test db + redis
 * db, see test-infra.ts). runFrontTurn is stubbed. Skipped automatically when the infra isn't reachable.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { resetTestState, setupTestInfra } from './test-infra.js';

vi.mock('../agent/front.js', () => ({ runFrontTurn: vi.fn() }));

const infra = await setupTestInfra({ name: 'consent', redisDb: 10, redisOffset: 4 });

const { sql } = await import('../db/index.js');
const { redis } = await import('../core/redis.js');
const { queue, QUEUE, closeQueues } = await import('../core/queues.js');
const { fakeCalls } = await import('../core/slack-fake.js');
const { processSlackEvent } = await import('./slack-events.js');
const debounce = await import('./debounce.js');
const privacy = await import('../features/privacy.js');
await import('./register.js');

const C = 'C0CONSENT';
let tsCounter = 100;
const nextTs = () => `1700000000.${String(tsCounter++).padStart(6, '0')}`;
const job = <D>(data: D) => ({ data, id: 'test' }) as unknown as Job<D>;
const messageEnvelope = (ev: Record<string, unknown>) =>
  job({ kind: 'event' as const, body: { event_id: `Ev${Math.random()}`, event: { type: 'message', channel: C, channel_type: 'channel', ...ev } } });
const click = (user: string, actionId: string, extra: Record<string, unknown> = {}) =>
  job({
    kind: 'interactive' as const,
    body: {
      type: 'block_actions',
      user: { id: user },
      channel: { id: C },
      container: { type: 'message', channel_id: C, is_ephemeral: true },
      response_url: 'https://hooks.slack.invalid/privacy',
      trigger_id: 'trig-1',
      actions: [{ action_id: actionId, value: 'x' }],
      ...extra,
    },
  });
const prompts = async () => (await fakeCalls()).filter((c) => c.method === 'chat.postEphemeral' && JSON.stringify(c.args.blocks ?? []).includes(privacy.PRIVACY_AGREE_ACTION));
const batchSeq = async (threadId: string, authorId: string) => Number((await redis.get(`debounce:seq:${threadId}:${authorId}`)) ?? 0);

describe.skipIf(!infra)('privacy consent (intake)', () => {
  beforeEach(async () => {
    await resetTestState();
    await sql`truncate privacy_consent, privacy_held`;
    await queue(QUEUE.turnDebounce).obliterate({ force: true }).catch(() => {});
    privacy.resetPrivacyCache();
    privacy.privacySettings.required = true;
  });
  afterAll(async () => {
    privacy.privacySettings.required = false;
    await closeQueues();
    await redis.quit();
    await sql.end({ timeout: 2 });
  });

  it('holds a mention behind the prompt, then replays it after "I agree"', async () => {
    const root = nextTs();
    const tid = `${C}:${root}`;
    await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> what is up?', ts: root }));
    // Stored as context, but no batch: a prompt instead (at the channel root, the message is top level).
    expect(await sql`select ts from messages where ts = ${root}`).toHaveLength(1);
    expect(await batchSeq(tid, 'U1')).toBe(0);
    const [p] = await prompts();
    expect(p!.args).toMatchObject({ channel: C, user: 'U1' });
    expect(p!.args.thread_ts).toBeUndefined();

    // A second mention in the same thread is held too, without a second prompt.
    const f = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> hello?', ts: f, thread_ts: root }));
    expect(await prompts()).toHaveLength(1);
    expect(await sql`select id from privacy_held where user_id = 'U1'`).toHaveLength(2);

    // Someone else isn't affected by U1's state, and gets their own prompt.
    await processSlackEvent(messageEnvelope({ user: 'U2', text: '<@UBOT> me too', ts: nextTs(), thread_ts: root }));
    expect(await prompts()).toHaveLength(2);

    await processSlackEvent(click('U1', privacy.PRIVACY_AGREE_ACTION));
    expect(await sql`select policy_version from privacy_consent where user_id = 'U1'`).toEqual([{ policyVersion: privacy.privacyPolicy().version }]);
    expect(await sql`select id from privacy_held where user_id = 'U1'`).toHaveLength(0);
    expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: await batchSeq(tid, 'U1') })).toEqual([
      { ts: root, reason: 'mention' },
      { ts: f, reason: 'mention' },
    ]);
    // The prompt was answered (the ephemeral removed / replaced).
    expect((await fakeCalls()).some((c) => c.method === 'response_url')).toBe(true);

    // From now on U1's mentions go straight to the batch.
    const g = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U1', text: '<@UBOT> and now?', ts: g, thread_ts: root }));
    expect(await debounce.takeBatch({ threadId: tid, authorId: 'U1', seq: await batchSeq(tid, 'U1') })).toEqual([{ ts: g, reason: 'mention' }]);
    expect(await prompts()).toHaveLength(2);
  });

  it('a group-ping redirect posts nothing until the user agrees', async () => {
    const src = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U3', text: '<!subteam^S1|@team> <@UBOT> help?', ts: src }));
    expect((await fakeCalls()).filter((c) => c.method === 'chat.postMessage')).toHaveLength(0);
    expect(await prompts()).toHaveLength(1);

    await processSlackEvent(click('U3', privacy.PRIVACY_AGREE_ACTION));
    const posts = (await fakeCalls()).filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args.text).toContain('<@U3>');
  });

  it('"Read the privacy policy" opens it in a modal', async () => {
    await processSlackEvent(click('U4', privacy.PRIVACY_READ_ACTION));
    const [open] = (await fakeCalls()).filter((c) => c.method === 'views.open');
    expect(open!.args.trigger_id).toBe('trig-1');
    expect(open!.args.view.type).toBe('modal');
    expect(open!.args.view.blocks.length).toBeGreaterThan(3);
  });

  it('is off when not required', async () => {
    privacy.privacySettings.required = false;
    const root = nextTs();
    await processSlackEvent(messageEnvelope({ user: 'U5', text: '<@UBOT> hi', ts: root }));
    expect(await batchSeq(`${C}:${root}`, 'U5')).toBe(1);
    expect(await prompts()).toHaveLength(0);
  });
});
