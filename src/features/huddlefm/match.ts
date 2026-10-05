/**
 * Choosing a HuddleFM search result. HuddleFM's top result for "title artist" is often a cover, a karaoke track, a
 * sped-up edit or a different song with a similar name; queueing it blindly is how a DJ ends up playing the wrong
 * thing. Results are scored against the wanted title and artist instead. Pure.
 */
import { songKey } from './protocol.js';

export interface SearchResult {
  label: string;
  reference: string;
}

export interface WantedSong {
  title: string;
  artist?: string;
}

/** Versions nobody wants unless they asked for them. */
const VARIANT_WORDS = [
  'karaoke',
  'instrumental',
  'cover',
  'tribute',
  'remix',
  'sped up',
  'speed up',
  'slowed',
  'reverb',
  'nightcore',
  '8d',
  'bass boosted',
  'live',
  'acoustic',
  'piano version',
  'lofi',
  'lo fi',
  'mashup',
  '1 hour',
  '10 hours',
  'loop',
  'reaction',
  'tutorial',
];

/** Lowercase words without accents or punctuation. Unlike songKey, bracketed parts stay: "(Karaoke Version)" counts. */
const plain = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const words = (s: string) => plain(s).split(' ').filter(Boolean);

/** Share of `needle`'s words that appear in `hay` (0..1). */
function coverage(needle: string[], hay: Set<string>): number {
  if (!needle.length) return 1;
  return needle.filter((w) => hay.has(w)).length / needle.length;
}

function variantsIn(text: string): string[] {
  const key = ` ${plain(text)} `;
  return VARIANT_WORDS.filter((v) => key.includes(` ${v} `));
}

export interface MatchScore {
  /** Share of the title's words found in the result. */
  title: number;
  /** Share of the artist's words found in the result (null: no artist given). */
  artist: number | null;
  /** Variant markers (cover, karaoke, sped up…) in the result that the request didn't ask for. */
  unwantedVariants: string[];
  score: number;
}

export function scoreResult(wanted: WantedSong, label: string): MatchScore {
  const hay = new Set(words(label));
  const title = coverage(words(wanted.title), hay);
  const artist = wanted.artist?.trim() ? coverage(words(wanted.artist), hay) : null;
  const asked = new Set(variantsIn(`${wanted.title} ${wanted.artist ?? ''}`));
  const unwantedVariants = variantsIn(label).filter((v) => !asked.has(v));
  const base = artist == null ? title : 0.6 * title + 0.4 * artist;
  return { title, artist, unwantedVariants, score: base - 0.5 * unwantedVariants.length };
}

/**
 * The result to queue for a wanted song, or null when none is a convincing match.
 * - strict (the auto DJ's own picks): the title must match and the artist mostly too, no unwanted variants. A miss is
 *   skipped rather than queueing a wrong song.
 * - lenient (a person asked): the best-scoring result, falling back to HuddleFM's top result when nothing scores well
 *   (free-text requests like "that song from the minecraft movie" don't contain the title's words).
 */
export function pickResult(wanted: WantedSong, results: SearchResult[], opts: { strict: boolean }): SearchResult | null {
  if (!results.length) return null;
  let best: { r: SearchResult; s: MatchScore } | null = null;
  for (const r of results) {
    const s = scoreResult(wanted, r.label);
    if (!best || s.score > best.s.score) best = { r, s };
  }
  const s = best!.s;
  if (opts.strict) {
    const ok = s.title >= 0.75 && (s.artist == null || s.artist >= 0.5) && s.unwantedVariants.length === 0;
    return ok ? best!.r : null;
  }
  return s.score >= 0.5 ? best!.r : results[0]!;
}

/**
 * True when `song` is already among `labels` ("title - artist" strings: playing, queued, played, picked). Matches on
 * the title's words plus the artist's first word, so "Song (Remastered 2011) - Artist" still counts as "Song".
 */
export function isDuplicateSong(song: WantedSong, labels: readonly string[]): boolean {
  const title = songKey(song.title);
  if (!title) return false;
  const artist = songKey(song.artist ?? '').split(' ')[0] ?? '';
  return labels.some((label) => {
    const key = ` ${songKey(label)} `;
    return key.includes(` ${title} `) && (!artist || key.includes(` ${artist} `));
  });
}
