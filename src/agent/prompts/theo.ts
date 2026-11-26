/**
 * Theo mode's voice (`theo.md`, next to this file; `pnpm build` copies it into dist). When the admin turns Theo mode
 * on (App Home, `src/features/theo-mode.ts`), this replaces the front prompt's "# Voice" section (`DEFAULT_VOICE`).
 */
import { readFileSync } from 'node:fs';

let cached: string | undefined;

/** theo.md as a "# Voice" section: its own top-level headings become subsections so the prompt's outline holds. */
export function theoVoice(): string {
  cached ??= `# Voice\n${readFileSync(new URL('./theo.md', import.meta.url), 'utf8').trim().replace(/^# /gm, '## ')}`;
  return cached;
}
