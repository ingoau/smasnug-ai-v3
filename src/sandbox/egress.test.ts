import { describe, expect, it } from 'vitest';
import { BLOCKED_V4, cidrsContain, complementCidrs, egressAllowlist, formatIp, parseCidr, parseIp, rangeToCidrs } from './egress.js';

const size = (c: string) => {
  const r = parseCidr(c);
  return r.end - r.start + 1n;
};

describe('egress allowlist', () => {
  const list = egressAllowlist();
  const v4 = list.filter((c) => !c.includes(':'));
  const v6 = list.filter((c) => c.includes(':'));

  it('allows public IPv4 addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '223.255.255.255', '192.167.255.255', '192.169.0.0'])
      expect(cidrsContain(list, ip), ip).toBe(true);
  });

  it('blocks private, loopback, link-local, CGNAT, metadata and reserved IPv4', () => {
    for (const ip of ['10.0.0.1', '10.255.255.255', '127.0.0.1', '169.254.169.254', '100.100.100.200', '100.64.0.0', '172.16.0.1', '172.31.255.255', '192.168.1.1', '0.0.0.0', '192.0.0.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '255.255.255.255', '240.0.0.1'])
      expect(cidrsContain(list, ip), ip).toBe(false);
  });

  it('covers exactly the IPv4 space minus the deny list, with no overlaps', () => {
    const blocked = complementCidrs(4, v4); // complement of the allowlist = the deny list, merged
    const total = 1n << 32n;
    const allowed = v4.reduce((s, c) => s + size(c), 0n);
    const denied = BLOCKED_V4.reduce((s, c) => s + size(c), 0n); // the deny entries don't overlap
    expect(allowed + denied).toBe(total);
    // Re-complementing gives back the deny list (as a minimal cover).
    const back = new Set(blocked);
    for (const c of BLOCKED_V4) expect(cidrsContain(blocked, formatIp(4, parseCidr(c).start)), c).toBe(true);
    expect(back.size).toBeLessThanOrEqual(BLOCKED_V4.length);
    // Sorted, non-overlapping.
    const parsed = v4.map(parseCidr);
    for (let i = 1; i < parsed.length; i++) expect(parsed[i]!.start).toBeGreaterThan(parsed[i - 1]!.end);
  });

  it('is short enough to pass as a provider parameter', () => {
    expect(v4.length).toBeLessThan(80);
    expect(v6.length).toBeLessThan(32);
  });

  it('allows global unicast IPv6 only, minus Teredo and 6to4', () => {
    for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:81a::200e', '2001:4860:4860::8888']) expect(cidrsContain(list, ip), ip).toBe(true);
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1', 'ff02::1', '2001::1', '2001:0:ffff::1', '2002:a00:1::1', '2002::'])
      expect(cidrsContain(list, ip), ip).toBe(false);
  });

  it('can leave IPv6 out entirely', () => {
    expect(egressAllowlist({ ipv6: false }).some((c) => c.includes(':'))).toBe(false);
  });

  it('applies extra deny entries (bare IPs and CIDRs, both families)', () => {
    const l = egressAllowlist({ extraDeny: ['203.0.114.7', '81.2.0.0/16', ' 2a01:4f8::1 '] });
    expect(cidrsContain(l, '203.0.114.7')).toBe(false);
    expect(cidrsContain(l, '203.0.114.8')).toBe(true);
    expect(cidrsContain(l, '81.2.200.1')).toBe(false);
    expect(cidrsContain(l, '81.3.0.1')).toBe(true);
    expect(cidrsContain(l, '2a01:4f8::1')).toBe(false);
    expect(cidrsContain(l, '2a01:4f8::2')).toBe(true);
  });
});

describe('CIDR helpers', () => {
  it('parses and formats IPv6', () => {
    expect(formatIp(6, parseIp('2001:db8:0:0:1:0:0:1').value)).toBe('2001:db8::1:0:0:1');
    expect(formatIp(6, parseIp('::').value)).toBe('::');
    expect(formatIp(6, parseIp('::ffff:1.2.3.4').value)).toBe('::ffff:102:304');
    expect(() => parseIp('1:2:3')).toThrow();
    expect(() => parseIp('1.2.3.256')).toThrow();
  });

  it('rejects CIDRs with host bits set', () => {
    expect(() => parseCidr('10.0.0.1/8')).toThrow();
  });

  it('splits ranges into minimal CIDRs', () => {
    expect(rangeToCidrs(4, parseIp('10.0.0.0').value, parseIp('10.0.0.255').value)).toEqual(['10.0.0.0/24']);
    expect(rangeToCidrs(4, parseIp('10.0.0.1').value, parseIp('10.0.0.6').value)).toEqual(['10.0.0.1/32', '10.0.0.2/31', '10.0.0.4/31', '10.0.0.6/32']);
    expect(complementCidrs(4, [])).toEqual(['0.0.0.0/0']);
    expect(complementCidrs(4, ['0.0.0.0/1'])).toEqual(['128.0.0.0/1']);
  });
});
