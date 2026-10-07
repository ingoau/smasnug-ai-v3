/**
 * Sandbox egress (docs/sandbox.md §5.2). Modal only has an outbound CIDR *allowlist*, so "open internet minus private
 * ranges" is built as the complement of a deny list. Pure; unit-tested in egress.test.ts.
 *
 * IPv4: everything except the private, loopback, link-local (incl. cloud metadata), CGNAT, benchmarking, multicast
 * and reserved ranges, plus any extra CIDRs (e.g. our own hosts' public IPs). Documentation ranges (TEST-NET-*) stay
 * allowed: nothing routes there, and each one would add ~15 CIDRs to the list.
 * IPv6: only global unicast (2000::/3), minus Teredo (2001::/32) and 6to4 (2002::/16), which can embed IPv4
 * addresses. Loopback, ULA (fc00::/7), link-local (fe80::/10), IPv4-mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96) and
 * multicast all lie outside 2000::/3, so they are never allowed.
 */

export const BLOCKED_V4 = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // private
  '100.64.0.0/10', // CGNAT (also Alibaba's metadata 100.100.100.200)
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, incl. metadata 169.254.169.254
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved + broadcast
] as const;

/** The only IPv6 space allowed: global unicast. */
export const ALLOWED_V6_BASE = '2000::/3';
/** Carved out of 2000::/3: tunnelling prefixes that embed IPv4 addresses. */
export const BLOCKED_V6_IN_BASE = ['2001::/32', '2002::/16'] as const;

type Family = 4 | 6;
interface Range {
  start: bigint;
  end: bigint; // inclusive
}

const BITS: Record<Family, number> = { 4: 32, 6: 128 };

export function parseIp(ip: string): { family: Family; value: bigint } {
  if (ip.includes(':')) return { family: 6, value: parseV6(ip) };
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`bad IPv4 address: ${ip}`);
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) throw new Error(`bad IPv4 address: ${ip}`);
    v = (v << 8n) | BigInt(Number(p));
  }
  return { family: 4, value: v };
}

function parseV6(ip: string): bigint {
  let s = ip;
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = parseIp(v4[1]!).value;
    s = s.slice(0, -v4[1]!.length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) throw new Error(`bad IPv6 address: ${ip}`);
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) throw new Error(`bad IPv6 address: ${ip}`);
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) throw new Error(`bad IPv6 address: ${ip}`);
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

export function parseCidr(cidr: string): { family: Family } & Range {
  const [ip, lenStr] = cidr.split('/');
  const { family, value } = parseIp(ip!);
  const bits = BITS[family];
  const len = lenStr === undefined ? bits : Number(lenStr);
  if (!Number.isInteger(len) || len < 0 || len > bits) throw new Error(`bad prefix length: ${cidr}`);
  const hostBits = BigInt(bits - len);
  const mask = (1n << hostBits) - 1n;
  if ((value & mask) !== 0n) throw new Error(`host bits set in ${cidr}`);
  return { family, start: value, end: value | mask };
}

export function formatIp(family: Family, v: bigint): string {
  if (family === 4) return [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 0xffn)).join('.');
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((v >> BigInt(i * 16)) & 0xffffn).toString(16));
  // Compress the longest run of zero groups (RFC 5952).
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best.len && j - i > 1) best = { at: i, len: j - i };
    i = j;
  }
  if (best.at < 0) return groups.join(':');
  return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.len).join(':')}`;
}

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1n) {
      if (r.end > last.end) last.end = r.end;
    } else out.push({ ...r });
  }
  return out;
}

/** Minimal CIDR cover of [start, end]. */
export function rangeToCidrs(family: Family, start: bigint, end: bigint): string[] {
  const bits = BITS[family];
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    // Largest block aligned at `cur` that fits in the remaining range.
    let size = 0;
    while (size < bits) {
      const next = size + 1;
      const blk = 1n << BigInt(next);
      if ((cur & (blk - 1n)) !== 0n || cur + blk - 1n > end) break;
      size = next;
    }
    out.push(`${formatIp(family, cur)}/${bits - size}`);
    cur += 1n << BigInt(size);
  }
  return out;
}

/** Complement of `blocked` within `within` (default: the whole family's space), as minimal CIDRs. */
export function complementCidrs(family: Family, blocked: readonly string[], within?: string): string[] {
  const all = within ? parseCidr(within) : { start: 0n, end: (1n << BigInt(BITS[family])) - 1n };
  const parsed = blocked.map(parseCidr);
  for (const p of parsed) if (p.family !== family) throw new Error(`mixed address families in the deny list`);
  const merged = merge(parsed.map((p) => ({ start: p.start < all.start ? all.start : p.start, end: p.end > all.end ? all.end : p.end })).filter((r) => r.start <= r.end));
  const out: string[] = [];
  let cur = all.start;
  for (const r of merged) {
    if (r.start > cur) out.push(...rangeToCidrs(family, cur, r.start - 1n));
    if (r.end + 1n > cur) cur = r.end + 1n;
  }
  if (cur <= all.end) out.push(...rangeToCidrs(family, cur, all.end));
  return out;
}

/**
 * The sandbox's outbound CIDR allowlist. `extraDeny` (e.g. env SANDBOX_EGRESS_DENY: our own hosts' public IPs) is
 * split by family; `ipv6` false leaves IPv6 out entirely (nothing allowed).
 */
export function egressAllowlist(opts: { extraDeny?: readonly string[]; ipv6?: boolean } = {}): string[] {
  const extra = (opts.extraDeny ?? []).map((c) => c.trim()).filter(Boolean).map((c) => (c.includes('/') ? c : `${c}/${c.includes(':') ? 128 : 32}`));
  const v4Extra = extra.filter((c) => !c.includes(':'));
  const v6Extra = extra.filter((c) => c.includes(':'));
  const v4 = complementCidrs(4, [...BLOCKED_V4, ...v4Extra]);
  const v6 = opts.ipv6 === false ? [] : complementCidrs(6, [...BLOCKED_V6_IN_BASE, ...v6Extra], ALLOWED_V6_BASE);
  return [...v4, ...v6];
}

/** True when `ip` falls inside one of `cidrs` (for tests and the live egress check). */
export function cidrsContain(cidrs: readonly string[], ip: string): boolean {
  const { family, value } = parseIp(ip);
  return cidrs.some((c) => {
    const r = parseCidr(c);
    return r.family === family && value >= r.start && value <= r.end;
  });
}
