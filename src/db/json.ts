/**
 * JSON for Postgres json / jsonb parameters. JSON.stringify writes a lone UTF-16 surrogate (a string cut between the
 * two halves of an emoji) as a `\udXXX` escape, which Postgres rejects (22P02) and fails the whole statement. Every
 * such escape in JSON.stringify's output is a lone surrogate (it writes valid pairs as the characters themselves),
 * so each one, unless its backslash is itself escaped, becomes U+FFFD.
 */
export function wellFormedJson(x: unknown): string {
  const s = JSON.stringify(x);
  if (s === undefined || !s.includes('\\ud')) return s;
  return s.replace(/(?<!\\)((?:\\\\)*)\\ud[89a-f][0-9a-f]{2}/g, '$1\\ufffd');
}
