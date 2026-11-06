import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deliverSkills, discoverSkills, parseSkillMd, readSkillsDir, withExcludes, writeSkill } from './index.ts';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'hyde-skills-'));
  dirs.push(d);
  return d;
}
function skill(root: string, folder: string, name: string, description: string, extra: Record<string, string> = {}) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nSteps.\n`);
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(root, folder, f), text);
}

describe('skills', () => {
  it('reads SKILL.md front matter', () => {
    expect(parseSkillMd('---\nname: a-b\ndescription: "Use when x"\n---\nbody')).toEqual({ name: 'a-b', description: 'Use when x', body: 'body' });
    expect(parseSkillMd('no front matter').name).toBeUndefined();
  });

  it('finds skills, skips invalid ones, and lets project beat user beat built-in', () => {
    const builtin = tmp();
    const user = tmp();
    const project = tmp();
    skill(builtin, 'deploy', 'deploy', 'built-in deploy steps');
    skill(builtin, 'lint', 'lint', 'built-in lint');
    skill(user, 'deploy', 'deploy', 'user deploy steps', { 'run.sh': 'echo hi' });
    skill(project, 'deploy', 'deploy', 'project deploy steps');
    skill(project, 'Bad Name', 'Bad Name', 'invalid name');
    skill(project, 'nodesc', 'nodesc', '');
    expect(readSkillsDir(user, 'user')[0]!.files).toEqual(['SKILL.md', 'run.sh']);
    const all = discoverSkills({ builtin, user, project });
    expect(all.map((s) => `${s.name}:${s.source}:${s.description}`)).toEqual(['deploy:project:project deploy steps', 'lint:builtin:built-in lint']);
  });

  it('ships a built-in skill', () => {
    expect(discoverSkills({}).map((s) => s.name)).toContain('hyde-verify');
  });

  it('copies skills where each CLI reads them, leaving a project copy alone', () => {
    const src = tmp();
    const worktree = tmp();
    skill(src, 'deploy', 'deploy', 'deploy steps', { 'run.sh': 'echo hi' });
    const skills = readSkillsDir(src, 'user');
    expect(deliverSkills(skills, worktree, 'claude-code')).toEqual(['.claude/skills/deploy']);
    expect(readFileSync(join(worktree, '.claude/skills/deploy/run.sh'), 'utf8')).toBe('echo hi');
    expect(deliverSkills(skills, worktree, 'opencode')).toEqual(['.opencode/skills/deploy']);
    expect(deliverSkills(skills, worktree, 'codex')).toEqual(['.agents/skills/deploy']);
    expect(deliverSkills(skills, worktree, 'claude-code')).toEqual([]); // already there
    expect(deliverSkills(skills, worktree, 'command')).toEqual([]);
  });

  it('keeps delivered skills out of commits with one managed exclude block', () => {
    const once = withExcludes('*.log\n', ['.claude/skills/deploy'])!;
    expect(once).toBe('*.log\n# >>> hyde skills (managed by Hyde Code; delivered per run, never committed)\n/.claude/skills/deploy/\n# <<< hyde skills\n');
    expect(withExcludes(once, ['.claude/skills/deploy'])).toBeNull();
    expect(withExcludes(once, ['.opencode/skills/deploy'])).toContain('/.claude/skills/deploy/\n/.opencode/skills/deploy/\n# <<< hyde skills');
  });

  it('writes an approved skill once', () => {
    const root = tmp();
    const dir = writeSkill(root, { name: 'run-e2e', description: 'Use to run e2e tests', body: 'npm run e2e' });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('---\nname: run-e2e\ndescription: Use to run e2e tests\n---\n\nnpm run e2e\n');
    expect(() => writeSkill(root, { name: 'run-e2e', description: 'x', body: 'y' })).toThrow(/already exists/);
    expect(() => writeSkill(root, { name: '../evil', description: 'x', body: 'y' })).toThrow(/lower-case/);
  });
});
