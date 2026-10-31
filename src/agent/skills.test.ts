import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { privacyPolicyPath } from '../features/privacy-path.js';
import { defaultSkillsDir, loadSkills, parseSkillFile, readSkill, skillsPrompt } from './skills.js';

function skillDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'skills-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe('parseSkillFile', () => {
  it('reads key: value frontmatter, quoted values and [a, b] lists', () => {
    const { meta, body } = parseSkillFile('---\nname: x\ndescription: "Use: when y"\nroles: [front, \'child\']\n---\n\n# Body\ntext\n');
    expect(meta).toEqual({ name: 'x', description: 'Use: when y', roles: ['front', 'child'] });
    expect(body).toBe('# Body\ntext');
  });

  it('no frontmatter: everything is the body', () => {
    expect(parseSkillFile('just text')).toEqual({ meta: {}, body: 'just text', errors: [] });
  });

  it('a BOM, CRLF line ends and comment lines are fine', () => {
    const r = parseSkillFile('\uFEFF---\r\n# a comment\r\nname: x\r\ndescription: d\r\n---\r\nbody');
    expect(r).toEqual({ meta: { name: 'x', description: 'd' }, body: 'body', errors: [] });
  });

  it('multi-line values are errors, not a description of ">"', () => {
    expect(parseSkillFile('---\ndescription: >\n  long\n  text\n---\nbody').errors).toHaveLength(3);
    expect(parseSkillFile('---\ndescription: |-\n---\nbody').errors).toEqual(["description: multi-line values aren't supported, put it on one line"]);
  });
});

describe('loadSkills', () => {
  const dir = skillDir({
    'alpha/SKILL.md': '---\ndescription: Alpha things.\n---\nAlpha body',
    'alpha/reference.md': 'ref',
    'alpha/sub/deep.txt': 'deep',
    'beta/SKILL.md': '---\nname: beta\ndescription: Beta things.\nroles: [child]\n---\nBeta body',
    'no-desc/SKILL.md': '---\nname: no-desc\n---\nbody',
    'Bad Name/SKILL.md': '---\ndescription: d\n---\nbody',
    'bad-role/SKILL.md': '---\ndescription: d\nroles: [gate]\n---\nbody',
    'folded/SKILL.md': '---\ndescription: >\n  folded text\n---\nbody',
    'empty-dir/.keep': '',
    'README.md': '# not a skill',
  });
  const all = loadSkills(dir);

  it('loads valid skills (name defaults to the directory), skips invalid ones', () => {
    expect(all.map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(all[0]).toMatchObject({ roles: ['front', 'child'], body: 'Alpha body', files: ['reference.md', 'sub/deep.txt'] });
  });

  it('a missing directory is no skills', () => {
    expect(loadSkills(path.join(dir, 'nope'))).toEqual([]);
  });

  it('the prompt lists only the role\'s skills, and nothing when there are none', () => {
    expect(skillsPrompt('front', all)).toMatch(/^# Skills\n[\s\S]*\n- alpha: Alpha things\.$/);
    expect(skillsPrompt('child', all)).toMatch(/- alpha: Alpha things\.\n- beta: Beta things\.$/);
    expect(skillsPrompt('front', [])).toBe('');
  });

  it('readSkill returns the body with its files, a listed file, or an error text', () => {
    expect(readSkill('front', 'alpha', undefined, all)).toBe('Alpha body\n\n---\nFiles in this skill (load_skill with file): reference.md, sub/deep.txt');
    expect(readSkill('front', 'alpha', './sub/deep.txt', all)).toBe('deep');
    expect(readSkill('front', 'beta', undefined, all)).toMatch(/No skill named "beta"\. Available: alpha/);
    expect(readSkill('front', 'alpha', '../beta/SKILL.md', all)).toMatch(/has no file/);
    expect(readSkill('front', 'alpha', 'SKILL.md', all)).toMatch(/has no file/);
  });
});

describe('the repo skills', () => {
  const all = loadSkills(defaultSkillsDir());

  it('load, and give the front agent about-yourself and subagents bot-source', () => {
    expect(skillsPrompt('front', all)).toMatch(/- about-yourself: /);
    expect(skillsPrompt('child', all)).toMatch(/- bot-source: /);
    expect(readSkill('front', 'about-yourself', undefined, all)).toMatch(/!stop/);
    expect(readSkill('child', 'bot-source', undefined, all)).toContain('raw.githubusercontent.com/ingoau/smasnug-ai-v3/main/');
    expect(readSkill('child', 'bot-source', undefined, all)).toContain('git clone --filter=blob:none https://github.com/ingoau/smasnug-ai-v3 /work/repo');
    expect(readSkill('front', 'about-yourself', undefined, all)).toMatch(/`sandbox: true` if answering means searching the code/);
  });

  it('about-yourself serves the privacy policy from the file consent uses, override included', () => {
    expect(readSkill('front', 'about-yourself', undefined, all)).toMatch(/Files in this skill \(load_skill with file\): .*privacy-policy\.md/);
    expect(readSkill('front', 'about-yourself', 'privacy-policy.md', all)).toBe(readFileSync(privacyPolicyPath(), 'utf8'));
    const other = path.join(mkdtempSync(path.join(tmpdir(), 'policy-')), 'POLICY.md');
    writeFileSync(other, 'Other policy');
    vi.stubEnv('PRIVACY_POLICY_PATH', other);
    try {
      expect(readSkill('front', 'about-yourself', 'privacy-policy.md', loadSkills(defaultSkillsDir()))).toBe('Other policy');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('requires', () => {
  const dir = skillDir({
    'dj/SKILL.md': '---\ndescription: DJ things.\nrequires: [huddlefm]\n---\nDJ body',
    'plain/SKILL.md': '---\ndescription: Plain things.\n---\nPlain body',
    'weird/SKILL.md': '---\ndescription: d\nrequires: [teleporter]\n---\nbody',
  });
  const all = loadSkills(dir);

  it('skips skills that need an unknown feature', () => {
    expect(all.map((s) => s.name)).toEqual(['dj', 'plain']);
  });

  it('lists and loads a skill only when its features are configured', () => {
    expect(skillsPrompt('front', all, () => false)).not.toMatch(/- dj:/);
    expect(skillsPrompt('front', all, () => false)).toMatch(/- plain:/);
    expect(readSkill('front', 'dj', undefined, all, () => false)).toMatch(/No skill named "dj"/);
    expect(skillsPrompt('front', all, (f) => f === 'huddlefm')).toMatch(/- dj: DJ things\./);
    expect(readSkill('front', 'dj', undefined, all, (f) => f === 'huddlefm')).toBe('DJ body');
  });

  it('the repo skills for optional features declare them', () => {
    const repo = loadSkills(defaultSkillsDir());
    expect(repo.find((s) => s.name === 'huddle-dj')?.requires).toEqual(['huddlefm']);
    expect(repo.find((s) => s.name === 'code-sandboxes')?.requires).toEqual(['sandbox']);
    expect(readSkill('front', 'huddle-dj', undefined, repo, () => true)).toMatch(/huddle_dj_mode/);
    expect(repo.find((s) => s.name === 'live-previews')?.requires).toEqual(['previews']);
  });

  it('a requires name must be an own feature, not an inherited property', () => {
    const odd = loadSkills(skillDir({ 'x/SKILL.md': '---\ndescription: d\nrequires: [toString]\n---\nbody' }));
    expect(odd).toEqual([]);
  });
});
