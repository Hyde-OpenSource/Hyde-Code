import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Skills: folders with a SKILL.md (YAML front matter `name` and `description`), the format
// Claude Code, Codex and OpenCode all read. The hub finds them, picks them per task, and copies
// the chosen ones into the worktree where each CLI looks for project skills.

export type SkillSource = 'builtin' | 'user' | 'project' | 'folder';

export interface Skill {
  name: string;
  description: string;
  /** Absolute folder holding SKILL.md. */
  dir: string;
  source: SkillSource;
  /** Files in the folder, relative to it. */
  files: string[];
}

/** Built-in skills shipped with Hyde (packages/skills/builtin). */
export const BUILTIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../builtin');

/**
 * Where each CLI reads project skills, relative to its working directory. Checked on 2026-11-06
 * against the installed CLIs: Claude Code 2.1.318 (`.claude/skills/<name>/SKILL.md`), OpenCode
 * 1.19.0 (`.opencode/skill(s)/<name>/SKILL.md` per its built-in docs), Codex 0.162.1 (`.agents/skills`).
 */
export const SKILL_DIRS: Record<string, string> = {
  'claude-code': '.claude/skills',
  opencode: '.opencode/skills',
  codex: '.agents/skills',
};

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Reads `name` and `description` from SKILL.md front matter (simple `key: value` lines). */
export function parseSkillMd(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { body: text };
  const out: { name?: string; description?: string; body: string } = { body: m[2]! };
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const value = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (kv[1] === 'name') out.name = value;
    else out.description = value;
  }
  return out;
}

export function renderSkillMd(skill: { name: string; description: string; body: string }): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description.replace(/\s+/g, ' ').trim()}\n---\n\n${skill.body.trim()}\n`;
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

/** Skills directly under `root` (each in its own folder). Invalid folders are skipped. */
export function readSkillsDir(root: string, source: SkillSource): Skill[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    const meta = parseSkillMd(readFileSync(file, 'utf8'));
    const name = meta.name ?? entry.name;
    if (!NAME.test(name) || !meta.description) continue;
    skills.push({ name, description: meta.description, dir, source, files: listFiles(dir) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SkillRoots {
  builtin?: string;
  /** ~/.hyde/skills */
  user?: string;
  /** <repo>/.hyde/skills */
  project?: string;
  /** Folders the owner linked (e.g. a devflow-skills clone's skills/ folder). */
  folders?: string[];
}

/** Every skill, one per name: project beats linked folders, which beat user, which beats built-in. */
export function discoverSkills(roots: SkillRoots): Skill[] {
  const byName = new Map<string, Skill>();
  const add = (list: Skill[]) => list.forEach((s) => byName.set(s.name, s));
  add(readSkillsDir(roots.builtin ?? BUILTIN_DIR, 'builtin'));
  if (roots.user) add(readSkillsDir(roots.user, 'user'));
  for (const f of roots.folders ?? []) add(readSkillsDir(f, 'folder'));
  if (roots.project) add(readSkillsDir(roots.project, 'project'));
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Copies skills into a worktree where the CLI reads them. A skill the worktree already has at
 * that path (committed by the project) is left alone. Returns the paths written, relative to the
 * worktree, so the caller can keep them out of commits.
 */
export function deliverSkills(skills: Skill[], worktree: string, adapter: string): string[] {
  const rel = SKILL_DIRS[adapter];
  if (!rel) return [];
  const written: string[] = [];
  for (const skill of skills) {
    const target = join(worktree, rel, skill.name);
    if (existsSync(join(target, 'SKILL.md'))) continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(skill.dir, target, { recursive: true });
    written.push(`${rel}/${skill.name}`);
  }
  return written;
}

const EXCLUDE_START = '# >>> hyde skills (managed by Hyde Code; delivered per run, never committed)';
const EXCLUDE_END = '# <<< hyde skills';

/**
 * Keeps delivered skill folders out of `git add -A` by listing them in the repository's
 * info/exclude (local only, never pushed). Returns the new file text, or null when unchanged.
 */
export function withExcludes(current: string, paths: string[]): string | null {
  const start = current.indexOf(EXCLUDE_START);
  const end = current.indexOf(EXCLUDE_END);
  const existing = start !== -1 && end > start ? current.slice(start + EXCLUDE_START.length, end).split('\n').filter(Boolean) : [];
  const all = [...new Set([...existing, ...paths.map((p) => `/${p}/`)])].sort();
  if (all.length === existing.length && existing.every((p, i) => p === all[i])) return null;
  const block = `${EXCLUDE_START}\n${all.join('\n')}\n${EXCLUDE_END}`;
  if (start !== -1 && end > start) return current.slice(0, start) + block + current.slice(end + EXCLUDE_END.length);
  return `${current}${current && !current.endsWith('\n') ? '\n' : ''}${block}\n`;
}

/** Writes a new skill folder (an approved proposal). Refuses to overwrite. */
export function writeSkill(root: string, skill: { name: string; description: string; body: string }): string {
  if (!NAME.test(skill.name)) throw new Error(`Skill name must be lower-case letters, digits and dashes: ${skill.name}`);
  const dir = join(root, skill.name);
  if (existsSync(dir)) throw new Error(`A skill named ${skill.name} already exists in ${root}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), renderSkillMd(skill));
  return dir;
}

export function isSkillName(name: string): boolean {
  return NAME.test(name);
}
