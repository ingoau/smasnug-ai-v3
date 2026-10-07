/**
 * Phase 0a spike (docs/sandbox.md §8): what Modal's JS SDK can do from Node. Not wired into the bot.
 *
 *   pnpm tsx --env-file=.env scripts/spikes/modal-spike.ts basic   # cheap: slim image, exec/files/snapshot/egress
 *   pnpm tsx --env-file=.env scripts/spikes/modal-spike.ts image   # builds the work image, cold start, Playwright
 *   pnpm tsx --env-file=.env scripts/spikes/modal-spike.ts billing # rates, environment budget/usage
 *   pnpm tsx --env-file=.env scripts/spikes/modal-spike.ts cleanup # terminate anything tagged spike=1
 *
 * Never prints credentials. Everything it creates is tagged { app: 'smasnug', spike: '1' } and terminated.
 */
import { ModalClient, type Sandbox } from 'modal';
import { egressAllowlist } from '../../src/sandbox/egress.js';

const ENV = process.env.MODAL_ENVIRONMENT;
const modal = new ModalClient({ environment: ENV });
const TAGS = { app: 'smasnug', spike: '1' };
const t0 = () => performance.now();
const ms = (s: number) => `${Math.round(performance.now() - s)} ms`;
const created: Sandbox[] = [];
const images: string[] = [];

async function sh(sb: Sandbox, cmd: string, opts: { timeoutMs?: number; user?: boolean } = {}) {
  const argv = opts.user ? ['setpriv', '--reuid=1000', '--regid=1000', '--init-groups', 'bash', '-lc', cmd] : ['bash', '-lc', cmd];
  const s = t0();
  const p = await sb.exec(argv, { timeoutMs: opts.timeoutMs, env: { HOME: '/work', LANG: 'C.UTF-8', TZ: 'UTC' }, workdir: '/work' });
  const [out, err] = await Promise.all([p.stdout.readText(), p.stderr.readText()]);
  const code = await p.wait();
  return { code, out: out.trim(), err: err.trim(), took: ms(s) };
}

async function app() {
  return modal.apps.fromName('smasnug-spike', { createIfMissing: true, environment: ENV });
}

const SLIM = () =>
  modal.images
    .fromRegistry('python:3.12-slim-bookworm')
    .dockerfileCommands([
      'RUN apt-get update && apt-get install -y --no-install-recommends curl iproute2 dnsutils && rm -rf /var/lib/apt/lists/*',
      'RUN useradd -m -u 1000 -d /work sandbox && chown sandbox:sandbox /work',
    ]);

async function basic() {
  const a = await app();
  console.log('app ok', a.appId.slice(0, 6) + '…');
  const allow = egressAllowlist({ ipv6: false });
  let s = t0();
  const sb = await modal.sandboxes.create(a, SLIM(), {
    cpu: 1,
    memoryMiB: 1024,
    timeoutMs: 10 * 60_000,
    workdir: '/work',
    outboundCidrAllowlist: allow,
    tags: TAGS,
  });
  created.push(sb);
  console.log('create (incl. image build on first run)', ms(s), 'cidrs', allow.length);

  console.log('whoami root:', await sh(sb, 'id -u; pwd'));
  console.log('whoami user:', await sh(sb, 'id -un; touch /work/x && echo can-write-work; touch /etc/x 2>&1 || true', { user: true }));
  console.log('exit code:', await sh(sb, 'echo out; echo err >&2; exit 7'));
  console.log('exec timeout (2s, sleep 10):', await sh(sb, 'sleep 10; echo done', { timeoutMs: 2000 }).catch((e) => `threw ${e?.constructor?.name}: ${e?.message}`));
  console.log('inner timeout:', await sh(sb, 'timeout --kill-after=1 2 sleep 10; echo rc=$?'));

  // Kill: does a second exec's pkill stop a running one?
  const longP = await sb.exec(['bash', '-lc', 'echo $$ > /tmp/long.pid; exec sleep 60'], {});
  await new Promise((r) => setTimeout(r, 1000));
  s = t0();
  await sh(sb, 'kill -TERM $(cat /tmp/long.pid)');
  console.log('kill via second exec: exit', await longP.wait(), ms(s));

  // Binary read/write 10 MB.
  const big = Buffer.alloc(10 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  s = t0();
  await sb.filesystem.writeBytes(big, '/work/big.bin');
  console.log('write 10 MB', ms(s));
  s = t0();
  const back = Buffer.from(await sb.filesystem.readBytes('/work/big.bin'));
  console.log('read 10 MB', ms(s), 'equal', back.equals(big));
  try {
    const big40 = Buffer.alloc(40 * 1024 * 1024, 1);
    s = t0();
    await sb.filesystem.writeBytes(big40, '/work/big40.bin');
    console.log('write 40 MB', ms(s));
    s = t0();
    const b40 = await sb.filesystem.readBytes('/work/big40.bin');
    console.log('read 40 MB', ms(s), b40.byteLength);
  } catch (e: any) {
    console.log('40 MB read/write failed:', e?.constructor?.name, e?.message);
  }
  console.log('stat:', await sb.filesystem.stat('/work/big.bin').then((i) => ({ size: i.size, owner: i.owner })));
  console.log('owner of written file:', await sh(sb, 'ls -ln /work/big.bin'));
  console.log('large stdout (200 KB):', await sh(sb, 'head -c 200000 /dev/zero | tr "\\0" a').then((r) => r.out.length));

  // Egress.
  console.log('egress 1.1.1.1:', await sh(sb, 'curl -sS -m 5 -o /dev/null -w "%{http_code}" https://1.1.1.1/', { user: true }));
  console.log('egress example.com (DNS):', await sh(sb, 'curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com/', { user: true }));
  for (const ip of ['10.0.0.1', '169.254.169.254', '100.100.100.200', '192.168.1.1', '127.0.0.1']) {
    console.log(`egress ${ip}:`, await sh(sb, `curl -sS -m 4 -o /dev/null -w "%{http_code}" http://${ip}/ 2>&1; echo " rc=$?"`, { user: true }));
  }
  console.log('ipv6 route:', await sh(sb, 'ip -6 addr 2>&1 | head -5; ip -6 route 2>&1 | head -3; curl -6 -sS -m 5 -o /dev/null -w "%{http_code}" https://[2606:4700:4700::1111]/ 2>&1; echo " rc=$?"'));
  console.log('resolv.conf:', await sh(sb, 'cat /etc/resolv.conf | grep -v "^#"'));

  // Tags + list.
  const listed: string[] = [];
  for await (const x of modal.sandboxes.list({ appId: a.appId, tags: TAGS, environment: ENV })) listed.push(x.sandboxId);
  console.log('list by tag finds it:', listed.includes(sb.sandboxId), listed.length);
  console.log('getTags:', await sb.getTags());

  // Usage (raw gRPC).
  try {
    const u = await (modal.cpClient as any).sandboxGetResourceUsage({ sandboxId: sb.sandboxId });
    console.log('resource usage:', { cpuCoreS: Number(u.cpuCoreNanosecs) / 1e9, memGibS: Number(u.memGibNanosecs) / 1e9 });
  } catch (e: any) {
    console.log('sandboxGetResourceUsage failed:', e?.message);
  }

  // Snapshot → terminate → create from snapshot.
  await sh(sb, 'echo hello > /work/keep.txt && chown sandbox /work/keep.txt');
  s = t0();
  const snap = await sb.snapshotFilesystem({ ttlMs: 24 * 60 * 60 * 1000 });
  images.push(snap.imageId);
  console.log('snapshotFilesystem', ms(s), 'image', snap.imageId.slice(0, 5) + '…');
  s = t0();
  await sb.terminate();
  console.log('terminate', ms(s), 'poll after:', await sb.poll());
  s = t0();
  const sb2 = await modal.sandboxes.create(a, snap, { cpu: 1, memoryMiB: 1024, timeoutMs: 5 * 60_000, workdir: '/work', outboundCidrAllowlist: allow, tags: TAGS });
  created.push(sb2);
  console.log('create from snapshot', ms(s));
  console.log('restored file:', await sh(sb2, 'cat /work/keep.txt; ls -l /work | head; id sandbox'));
  s = t0();
  await sb2.terminate();
  console.log('terminate 2', ms(s));
  // Terminate twice (idempotency).
  await sb2.terminate().then(() => console.log('second terminate ok'), (e) => console.log('second terminate threw', e?.constructor?.name, e?.message));
  // fromId on a terminated sandbox.
  await modal.sandboxes.fromId(sb2.sandboxId).then(
    async (x) => console.log('fromId terminated → ok, poll', await x.poll()),
    (e) => console.log('fromId terminated threw', e?.constructor?.name, e?.message),
  );
  // Delete the snapshot image.
  s = t0();
  await modal.images.delete(snap.imageId).then(() => console.log('image delete ok', ms(s)), (e) => console.log('image delete threw', e?.constructor?.name, e?.message));
  await modal.images.fromId(snap.imageId).then(() => console.log('fromId after delete: still resolves'), (e) => console.log('fromId after delete threw', e?.constructor?.name));

  // Timeout (lifetime) kill: create with 15 s timeout and watch it die.
  s = t0();
  const sb3 = await modal.sandboxes.create(a, SLIM(), { timeoutMs: 15_000, tags: TAGS, outboundCidrAllowlist: allow });
  created.push(sb3);
  const code = await sb3.wait();
  console.log('lifetime kill after', ms(s), 'exit', code);
  await sh(sb3, 'echo hi').then((r) => console.log('exec on dead sandbox:', r), (e) => console.log('exec on dead sandbox threw', e?.constructor?.name, e?.message));
}

const WORK_IMAGE = () =>
  modal.images
    .fromRegistry('mcr.microsoft.com/playwright:v1.56.1-noble')
    .dockerfileCommands([
      'ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
      'RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv git jq sqlite3 zip unzip curl ca-certificates && rm -rf /var/lib/apt/lists/*',
      'RUN pip3 install --break-system-packages --no-cache-dir numpy pandas matplotlib pillow openpyxl requests beautifulsoup4 playwright==1.56.0',
      'RUN npm install -g pnpm@10 playwright@1.56.1',
      'RUN (id -u ubuntu >/dev/null 2>&1 && userdel -r ubuntu || true) && useradd -m -u 1000 -d /work sandbox && chown sandbox:sandbox /work',
    ]);

async function image() {
  const a = await app();
  let s = t0();
  const img = await WORK_IMAGE().build(a);
  console.log('work image build', ms(s), img.imageId.slice(0, 5) + '…');
  s = t0();
  const sb = await modal.sandboxes.create(a, img, { cpu: 1, memoryMiB: 2048, timeoutMs: 10 * 60_000, workdir: '/work', outboundCidrAllowlist: egressAllowlist({ ipv6: false }), tags: TAGS });
  created.push(sb);
  console.log('create from built image', ms(s));
  console.log('versions:', await sh(sb, 'node -v; python3 --version; pnpm -v; npx playwright --version; python3 -c "import pandas, matplotlib; print(pandas.__version__)"', { user: true }));
  const script = `const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage(); await p.setContent('<h1>hi</h1>'); await p.screenshot({ path: '/work/shot.png' }); await b.close(); console.log('ok'); })();`;
  await sb.filesystem.writeText(script, '/work/shot.js');
  console.log('playwright node screenshot:', await sh(sb, 'NODE_PATH=$(npm root -g) node shot.js && ls -l shot.png', { user: true, timeoutMs: 90_000 }));
  console.log('playwright python screenshot:', await sh(sb, `python3 -c "
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.set_content('<h1>hi</h1>'); pg.screenshot(path='/work/shot2.png'); b.close(); print('ok')
"`, { user: true, timeoutMs: 90_000 }));
  console.log('matplotlib:', await sh(sb, `python3 -c "
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.savefig('/work/c.png'); print('ok')"`, { user: true, timeoutMs: 60_000 }));
  // Faster binary transfer through exec stdin/stdout?
  const big = Buffer.alloc(10 * 1024 * 1024, 7);
  s = t0();
  const w = await sb.exec(['bash', '-c', 'cat > /work/big2.bin'], { mode: 'binary' });
  const writer = w.stdin.getWriter();
  await writer.write(new Uint8Array(big));
  await writer.close();
  console.log('stdin write 10 MB exit', await w.wait(), ms(s));
  s = t0();
  const r = await sb.exec(['cat', '/work/big2.bin'], { mode: 'binary' });
  const bytes = await r.stdout.readBytes();
  console.log('stdout read 10 MB', bytes.byteLength, 'exit', await r.wait(), ms(s));
  console.log('dns via 172.21.0.1:', await sh(sb, 'getent hosts example.com; python3 -c "import socket;print(socket.getaddrinfo(\'pypi.org\',443)[0][4])"'));
  await sb.terminate();
  s = t0();
  const sb2 = await modal.sandboxes.create(a, img, { cpu: 1, memoryMiB: 2048, timeoutMs: 5 * 60_000, tags: TAGS });
  created.push(sb2);
  console.log('second create (warm image)', ms(s));
  s = t0();
  console.log('first exec', (await sh(sb2, 'true')).took, ms(s));
  await sb2.terminate();
}

async function billing() {
  const cp = modal.cpClient as any;
  try {
    const r = await cp.workspaceBillingRates({});
    console.log('rates:', JSON.stringify(r.rates));
  } catch (e: any) {
    console.log('workspaceBillingRates failed:', e?.message);
  }
  try {
    const envs = await cp.environmentList({});
    for (const e of envs.items ?? []) {
      if (e.name !== ENV) continue;
      const id = e.environmentId ?? e.id;
      const b = await cp.environmentGetBudget({ environmentId: id }).catch((x: any) => ({ error: x?.message }));
      console.log('env budget', e.name, JSON.stringify(b));
      const sum = await cp.environmentBillingSummary({ environmentId: id, startTimestamp: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) }).catch((x: any) => ({ error: x?.message }));
      console.log('env billing summary', JSON.stringify(sum));
    }
    console.log('env names:', (envs.items ?? []).map((e: any) => e.name));
  } catch (e: any) {
    console.log('environmentList failed:', e?.message);
  }
  try {
    const s = await cp.workspaceBillingSummary({ startTimestamp: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) });
    console.log('workspace billing summary', JSON.stringify(s));
  } catch (e: any) {
    console.log('workspaceBillingSummary failed:', e?.message);
  }
}

async function cleanup() {
  let n = 0;
  for await (const sb of modal.sandboxes.list({ tags: TAGS, environment: ENV })) {
    await sb.terminate().catch(() => {});
    n++;
  }
  console.log('terminated', n);
}

const stage = process.argv[2] ?? 'basic';
const fns: Record<string, () => Promise<void>> = { basic, image, billing, cleanup };
try {
  await fns[stage]!();
} catch (e: any) {
  console.error('FAILED', e?.constructor?.name, e?.message);
  process.exitCode = 1;
} finally {
  for (const sb of created) await sb.terminate().catch(() => {});
  for (const id of images) await modal.images.delete(id).catch(() => {});
  modal.close();
}
