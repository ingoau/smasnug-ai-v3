/** RFC 6238 TOTP codes from a stored seed, so a login's 2FA step works without the seed leaving the bot. */
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpParams {
  secret: Buffer;
  digits: number;
  period: number;
  algorithm: 'sha1' | 'sha256' | 'sha512';
}

/** A base32 seed or an `otpauth://totp/...?secret=…` URI. Throws on anything else. */
export function parseTotp(raw: string): TotpParams {
  const t = raw.trim();
  if (t.toLowerCase().startsWith('otpauth://')) {
    const u = new URL(t);
    if (u.host.toLowerCase() !== 'totp') throw new Error('only TOTP (not HOTP) is supported');
    const secret = u.searchParams.get('secret');
    if (!secret) throw new Error('the otpauth URI has no secret');
    const algo = (u.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
    if (algo !== 'sha1' && algo !== 'sha256' && algo !== 'sha512') throw new Error('unsupported TOTP algorithm');
    const digits = Number(u.searchParams.get('digits') ?? 6);
    const period = Number(u.searchParams.get('period') ?? 30);
    if (![6, 7, 8].includes(digits) || !(period >= 10 && period <= 120)) throw new Error('unsupported TOTP digits / period');
    return { secret: base32Decode(secret), digits, period, algorithm: algo };
  }
  const secret = base32Decode(t);
  if (secret.length < 10) throw new Error('that TOTP secret is too short');
  return { secret, digits: 6, period: 30, algorithm: 'sha1' };
}

export function totpCode(raw: string, now = Date.now()): { code: string; secondsLeft: number } {
  const p = parseTotp(raw);
  const counter = Math.floor(now / 1000 / p.period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(p.algorithm, p.secret).update(buf).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  const code = String(bin % 10 ** p.digits).padStart(p.digits, '0');
  return { code, secondsLeft: p.period - (Math.floor(now / 1000) % p.period) };
}

export function validTotp(raw: string): boolean {
  try {
    totpCode(raw);
    return true;
  } catch {
    return false;
  }
}
