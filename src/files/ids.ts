/** File ids (pure): `file_` + 10 random lowercase alphanumerics, e.g. `file_k3x9q2mf7a`. */
import { randomInt } from 'node:crypto';

export const FILE_ID_RE = /^file_[a-z0-9]{10}$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new random file id. `rand(n)` returns an integer in [0, n) (crypto by default; injectable for tests). */
export function newFileId(rand: (n: number) => number = randomInt): string {
  let s = 'file_';
  for (let i = 0; i < 10; i++) s += ALPHABET[rand(ALPHABET.length)];
  return s;
}

export function isFileId(s: string): boolean {
  return FILE_ID_RE.test(s);
}

export type FileRef = { kind: 'id'; id: string } | { kind: 'legacy_image'; n: number };

/**
 * What the model passed as a file id: `file_k3x9q2mf7a` (also inside a pasted placeholder like
 * `[file file_k3x9q2mf7a: …]`, any case), or a pre-file-store image id `img_3` (migrated threads keep resolving them).
 */
export function parseFileRef(input: string): FileRef | null {
  const s = (input ?? '').trim().toLowerCase();
  const m = /\bfile_[a-z0-9]{10}\b/.exec(s);
  if (m) return { kind: 'id', id: m[0] };
  const legacy = /^\[?(?:image\s+)?img_?(\d{1,6})\b/.exec(s);
  if (legacy) return { kind: 'legacy_image', n: Number(legacy[1]) };
  return null;
}
