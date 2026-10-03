/**
 * Minimal partial-JSON reader for streamed tool arguments. Extracts the (possibly still-growing) value of one
 * top-level string field from an incomplete JSON object, e.g. `{"text":"Hello wor` → `Hello wor`.
 * Only fully decoded characters are returned: a trailing incomplete escape (`\`, `\u12`) is held back, so the
 * returned value is always a prefix of the final value.
 */
export interface PartialString {
  value: string;
  /** The closing quote has been seen. */
  complete: boolean;
}

export function extractPartialString(json: string, field: string): PartialString | undefined {
  let i = 0;
  const n = json.length;
  const ws = () => {
    while (i < n && /\s/.test(json[i]!)) i++;
  };

  /** Reads a JSON string starting at the opening quote. */
  const readString = (): PartialString => {
    i++; // opening quote
    let out = '';
    while (i < n) {
      const c = json[i]!;
      if (c === '"') {
        i++;
        return { value: out, complete: true };
      }
      if (c === '\\') {
        if (i + 1 >= n) return { value: out, complete: false };
        const e = json[i + 1]!;
        if (e === 'u') {
          const hex = json.slice(i + 2, i + 6);
          if (hex.length < 4) return { value: out, complete: false };
          const code = parseInt(hex, 16);
          // Surrogate pair: hold back a lone high surrogate until its partner arrives.
          if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 12 > n) return { value: out, complete: false };
            if (json[i + 6] === '\\' && json[i + 7] === 'u') {
              const low = parseInt(json.slice(i + 8, i + 12), 16);
              out += String.fromCharCode(code, low);
              i += 12;
              continue;
            }
          }
          out += String.fromCharCode(code);
          i += 6;
          continue;
        }
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
        out += map[e] ?? e;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return { value: out, complete: false };
  };

  /** Skips any JSON value; returns false if input ended inside it. */
  const skipValue = (): boolean => {
    ws();
    if (i >= n) return false;
    const c = json[i]!;
    if (c === '"') return readString().complete;
    if (c === '{' || c === '[') {
      let depth = 0;
      while (i < n) {
        const d = json[i]!;
        if (d === '"') {
          if (!readString().complete) return false;
          continue;
        }
        if (d === '{' || d === '[') depth++;
        if (d === '}' || d === ']') {
          depth--;
          if (depth === 0) {
            i++;
            return true;
          }
        }
        i++;
      }
      return false;
    }
    while (i < n && !/[,}\]\s]/.test(json[i]!)) i++;
    return i < n;
  };

  ws();
  if (json[i] !== '{') return undefined;
  i++;
  while (i < n) {
    ws();
    if (json[i] === '}') return undefined;
    if (json[i] === ',') {
      i++;
      continue;
    }
    if (json[i] !== '"') return undefined;
    const key = readString();
    if (!key.complete) return undefined;
    ws();
    if (json[i] !== ':') return undefined;
    i++;
    ws();
    if (i >= n) return undefined;
    if (key.value === field) {
      if (json[i] !== '"') return undefined;
      return readString();
    }
    if (!skipValue()) return undefined;
  }
  return undefined;
}
