/**
 * Where the privacy policy lives: `PRIVACY.md` at the repo root, or `PRIVACY_POLICY_PATH`. Its own module, free of
 * config/DB imports, so the skill loader (src/agent/skills.ts) serves the exact file consent hashes.
 */
import { fileURLToPath } from 'node:url';

export function privacyPolicyPath(): string {
  return process.env.PRIVACY_POLICY_PATH || fileURLToPath(new URL('../../PRIVACY.md', import.meta.url));
}
