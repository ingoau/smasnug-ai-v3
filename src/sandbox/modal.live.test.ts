/**
 * The Modal provider against real Modal (the MODAL_* credentials in .env, its dev environment). Costs a few cents of
 * the free credit; every sandbox and snapshot it creates is destroyed / deleted, also on failure.
 *   LIVE=1 pnpm vitest run src/sandbox/modal.live.test.ts
 * Build the images first (`pnpm sandbox:images`), or the first create waits for the build.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

const LIVE = process.env.LIVE === '1';
vi.hoisted(() => {
  if (process.env.LIVE === '1') {
    try {
      process.loadEnvFile('.env');
    } catch {}
    process.env.LOG_LEVEL = 'silent';
  }
  process.env.OPENROUTER_KEY ||= 'test';
});

describe.skipIf(!LIVE || !process.env.MODAL_TOKEN_ID)('Modal provider (live)', () => {
  const runTag = `live-${Date.now().toString(36)}`;
  let provider: import('./modal.js').ModalProvider;
  const handles: { providerId: string }[] = [];
  const snapshots: import('./provider.js').Paused[] = [];

  async function spec() {
    const { workSpec } = await import('./lifecycle.js');
    const s = workSpec(`sbx_${runTag}`);
    return { ...s, lifetimeMs: 10 * 60_000, tags: { ...s.tags, test: runTag } };
  }
  async function p() {
    if (!provider) provider = new (await import('./modal.js')).ModalProvider();
    return provider;
  }
  const sh = async (h: { providerId: string }, cmd: string, o: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    (await p()).exec(h, ['bash', '-c', cmd], { timeoutMs: o.timeoutMs ?? 60_000, maxOutputBytes: 64 * 1024, signal: o.signal });

  afterAll(async () => {
    if (!provider) return;
    for (const h of handles) await provider.destroy(h).catch(() => {});
    for (const s of snapshots) await provider.deletePaused(s).catch(() => {});
    // Anything left with this run's tag (e.g. a create that threw after starting).
    for (const x of await provider.list({ test: runTag }).catch(() => [])) await provider.destroy(x).catch(() => {});
  }, 120_000);

  it('create → exec (non-root, egress) → write/read → destroy', async () => {
    const h = await (await p()).create(await spec());
    handles.push(h);
    const who = await sh(h, 'id -un; pwd; touch /etc/x 2>/dev/null && echo root-write || echo no-root-write');
    expect(who.exitCode).toBe(0);
    expect(who.stdout.toString()).toBe('sandbox\n/work\nno-root-write\n');
    const env = await sh(h, 'env | sort | cut -d= -f1 | tr "\\n" " "');
    expect(env.stdout.toString()).not.toMatch(/MODAL|SLACK|OPENROUTER|TOKEN|SECRET/);

    const egress = await sh(h, 'curl -sS -m 6 -o /dev/null -w "%{http_code}" https://1.1.1.1/ ; echo; for ip in 10.0.0.1 169.254.169.254 100.100.100.200; do curl -sS -m 3 -o /dev/null http://$ip/ 2>/dev/null && echo "$ip open" || echo "$ip blocked"; done');
    const lines = egress.stdout.toString().trim().split('\n');
    expect(lines[0]).toMatch(/^[23]\d\d$/);
    expect(lines.slice(1)).toEqual(['10.0.0.1 blocked', '169.254.169.254 blocked', '100.100.100.200 blocked']);

    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    await (await p()).writeFile(h, '/work/sub/dir/data.bin', bytes);
    const ls = await sh(h, 'stat -c "%U %s" /work/sub/dir/data.bin');
    expect(ls.stdout.toString().trim()).toBe('sandbox 300000');
    const back = await (await p()).readFile(h, '/work/sub/dir/data.bin', { maxBytes: 1_000_000 });
    expect(back.bytes.equals(bytes)).toBe(true);
    const tooBig = await (await p()).readFile(h, '/work/sub/dir/data.bin', { maxBytes: 1000 });
    expect(tooBig).toEqual({ bytes: Buffer.alloc(0), size: 300000 });

    const py = await sh(h, `python3 -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.plot([1,3,2]); plt.savefig('/work/c.png'); print('ok')"`, { timeoutMs: 90_000 });
    expect(py.stdout.toString().trim()).toBe('ok');
    const png = await (await p()).readFile(h, '/work/c.png', { maxBytes: 5_000_000 });
    expect(png.bytes.subarray(1, 4).toString()).toBe('PNG');

    await (await p()).destroy(h);
    await (await p()).destroy(h); // idempotent
    await expect(sh(h, 'true')).rejects.toThrow();
  }, 240_000);

  it('exec timeout and abort', async () => {
    const h = await (await p()).create(await spec());
    handles.push(h);
    const t = await sh(h, 'sleep 30', { timeoutMs: 2000 });
    expect(t.timedOut).toBe(true);
    expect(t.durationMs).toBeLessThan(15_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    const a = await sh(h, 'sleep 60; echo late', { timeoutMs: 90_000, signal: ac.signal });
    expect(a.aborted).toBe(true);
    expect(a.durationMs).toBeLessThan(20_000);
    expect(a.stdout.toString()).not.toContain('late');
    await (await p()).destroy(h);
  }, 180_000);

  it('pause (snapshot + terminate) → resume keeps files → destroy + delete snapshot', async () => {
    const h = await (await p()).create(await spec());
    handles.push(h);
    await (await p()).writeFile(h, '/work/keep.txt', Buffer.from('still here'));
    const paused = await (await p()).pause(h);
    snapshots.push(paused);
    expect(paused.kind).toBe('fs-snapshot');
    const h2 = await (await p()).resume(paused, await spec());
    handles.push(h2);
    const r = await sh(h2, 'cat /work/keep.txt; stat -c %U /work/keep.txt');
    expect(r.stdout.toString()).toBe('still heresandbox\n');
    const listed = await (await p()).list({ test: runTag });
    expect(listed.map((x) => x.providerId)).toContain(h2.providerId);
    expect(listed.find((x) => x.providerId === h2.providerId)!.tags.kind).toBe('work');
    await (await p()).destroy(h2);
    await (await p()).deletePaused(paused);
    await expect((await p()).resume(paused, await spec())).rejects.toThrow();
  }, 240_000);
});
