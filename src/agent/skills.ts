/**
 * Agent skills: knowledge and procedures loaded on demand instead of living in the system prompt.
 *
 * A skill is a directory under `skills/` (repo root; `SKILLS_DIR` overrides) holding a `SKILL.md`: YAML-style
 * frontmatter (`name`, `description`, optional `roles: [front, child]`, optional `requires: [huddlefm]`) and a markdown
 * body. Only the name and
 * description go into the system prompt (`skillsPrompt`); the agent calls `load_skill` to read the body, and any
 * other file in the skill's directory (`load_skill` with `file`). Read once per process and cached; the index is
 * stable, so the system prompt stays cacheable. See skills/README.md.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '../core/tools.js';
import { log } from '../log.js';

export type SkillRole = Extract<Role, 'front' | 'child'>;

export interface Skill {
  name: string;
  description: string;
  roles: SkillRole[];
  /** Optional features (SKILL_FEATURES) that must be configured for the skill to be offered. */
  requires: string[];
  body: string;
  dir: string;
  /** Other files in the skill directory, relative paths with `/` separators (SKILL.md excluded). */
  files: string[];
}

const ROLES: SkillRole[] = ['front', 'child'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILE_BYTES = 200_000;

/**
 * Optional features a skill can depend on (`requires:`): a skill whose feature isn't configured is neither listed nor
 * loadable, so its instructions don't sit in the prompt of a deployment that can't use them. Same checks as
 * huddleFmConfigured / sandboxConfigured on the raw env (not imported: those modules pull in Redis / Postgres, and
 * config.js would make this loader need a full environment).
 */
export const SKILL_FEATURES: Record<string, () => boolean> = {
  huddlefm: () => Boolean(process.env.HUDDLEFM_USER_ID),
  sandbox: () => Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET),
  /** previewsConfigured: sandboxes plus the key that encrypts preview tokens. */
  previews: () => Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET && process.env.PREVIEW_SECRET_KEY),
};

export type FeatureCheck = (feature: string) => boolean;
const configured: FeatureCheck = (f) => Object.hasOwn(SKILL_FEATURES, f) && SKILL_FEATURES[f]!();

/** `<repo>/skills`, from both src/agent (tsx) and dist/agent (build). */
export function defaultSkillsDir(): string {
  return process.env.SKILLS_DIR || fileURLToPath(new URL('../../skills/', import.meta.url));
}

/**
 * Minimal frontmatter: one-line `key: value` pairs, values optionally quoted, `[a, b]` lists. Anything richer (block
 * scalars like `description: >`, indented continuation lines) is reported in `errors` instead of being misread.
 */
export function parseSkillFile(text: string): { meta: Record<string, string | string[]>; body: string; errors: string[] } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.replace(/^\uFEFF/, '').trim(), errors: [] };
  const meta: Record<string, string | string[]> = {};
  const errors: string[] = [];
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      errors.push(`unsupported frontmatter line (keep each value on one line): ${line.trim()}`);
      continue;
    }
    const raw = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(raw)) {
      errors.push(`${kv[1]}: multi-line values aren't supported, put it on one line`);
      continue;
    }
    const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
    meta[kv[1]!] = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1).split(',').map(unquote).filter(Boolean) : unquote(raw);
  }
  return { meta, body: m[2]!.trim(), errors };
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(path.join(dir, ent.name), rel));
    else if (ent.isFile() && rel !== 'SKILL.md') out.push(rel);
  }
  return out.sort();
}

/** Reads every `<dir>/<skill>/SKILL.md`. Invalid skills are skipped with a warning, never thrown. */
export function loadSkills(dir: string): Skill[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    const skillDir = path.join(dir, entry);
    let text: string;
    try {
      if (!statSync(skillDir).isDirectory()) continue;
      text = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const { meta, body, errors } = parseSkillFile(text);
    if (errors.length) {
      log.warn({ skill: entry, errors }, 'skipping skill: invalid frontmatter');
      continue;
    }
    const name = typeof meta.name === 'string' && meta.name ? meta.name : entry;
    const description = typeof meta.description === 'string' ? meta.description.trim() : '';
    const rawRoles = meta.roles === undefined ? ROLES : Array.isArray(meta.roles) ? meta.roles : [meta.roles];
    const roles = rawRoles.filter((r): r is SkillRole => (ROLES as string[]).includes(r));
    const requires = meta.requires === undefined ? [] : Array.isArray(meta.requires) ? meta.requires : [meta.requires];
    if (!NAME_RE.test(name) || !description || !body || !roles.length) {
      log.warn({ skill: entry }, 'skipping skill: needs a lowercase name, a description, a body and a valid role');
      continue;
    }
    const unknown = requires.filter((f) => !Object.hasOwn(SKILL_FEATURES, f));
    if (unknown.length) {
      log.warn({ skill: entry, unknown }, 'skipping skill: unknown feature in requires');
      continue;
    }
    if (skills.some((s) => s.name === name)) {
      log.warn({ skill: name }, 'skipping duplicate skill name');
      continue;
    }
    skills.push({ name, description, roles, requires, body, dir: skillDir, files: listFiles(skillDir) });
  }
  return skills;
}

let cache: Skill[] | undefined;

export function skills(): Skill[] {
  return (cache ??= loadSkills(defaultSkillsDir()));
}

/** The role's skills whose required features are all configured. */
export function skillsFor(role: SkillRole, all: Skill[] = skills(), enabled: FeatureCheck = configured): Skill[] {
  return all.filter((s) => s.roles.includes(role) && s.requires.every(enabled));
}

/** The system prompt section listing the role's skills ('' when there are none). */
export function skillsPrompt(role: SkillRole, all: Skill[] = skills(), enabled: FeatureCheck = configured): string {
  const list = skillsFor(role, all, enabled);
  if (!list.length) return '';
  return `# Skills
Skills hold knowledge and procedures that aren't in this prompt. When a request matches a skill's description, call load_skill with its name before answering or acting, and follow what it says (a skill never overrides the safety rules above). Load only what the request needs. A skill you loaded earlier in this turn (or task) is still valid; one from an earlier turn isn't shown to you, so load it again.
${list.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
}

/**
 * The text load_skill returns: the body (plus its file list), or one file of the skill. Errors are returned as
 * plain text for the model, never thrown.
 */
export function readSkill(role: SkillRole, name: string, file?: string, all: Skill[] = skills(), enabled: FeatureCheck = configured): string {
  const list = skillsFor(role, all, enabled);
  const skill = list.find((s) => s.name === name.trim());
  if (!skill) return `No skill named "${name}". Available: ${list.map((s) => s.name).join(', ') || 'none'}.`;
  if (!file?.trim()) {
    const files = skill.files.length ? `\n\n---\nFiles in this skill (load_skill with file): ${skill.files.join(', ')}` : '';
    return `${skill.body}${files}`;
  }
  const rel = file.trim().replace(/^\.?\//, '');
  if (!skill.files.includes(rel)) return `Skill "${skill.name}" has no file "${rel}". Files: ${skill.files.join(', ') || 'none'}.`;
  // `rel` is one of the listed files (no symlinks), so it can't escape the skill directory.
  let buf: Buffer;
  try {
    buf = readFileSync(path.join(skill.dir, rel));
  } catch {
    return `Couldn't read "${rel}" from skill "${skill.name}".`;
  }
  if (buf.length > MAX_FILE_BYTES) return `${buf.subarray(0, MAX_FILE_BYTES).toString('utf8')}\n\n[truncated at ${MAX_FILE_BYTES} bytes]`;
  return buf.toString('utf8');
}
