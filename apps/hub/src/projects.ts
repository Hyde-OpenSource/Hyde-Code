import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { readRawConfig, writeRawConfig, type RawConfig } from './config.ts';
import { guessProject } from './setup.ts';

// Projects are folders. `hyde` in a folder (or "Add project" in the dashboard) registers
// it once; after that it shows up in every view.

export type RawProject = NonNullable<RawConfig['projects']>[number];

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'));
}

/** A short id for `#id` in chat, unique among the existing projects. */
export function projectId(path: string, taken: string[]): string {
  const base = basename(path).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export function findProject(raw: RawConfig | undefined, path: string): RawProject | undefined {
  const abs = resolve(path);
  return raw?.projects?.find((p) => resolve(p.path) === abs);
}

/** Project settings guessed from the folder: base branch, checks, preview command. */
export async function projectFromFolder(path: string, existing: RawProject[]): Promise<RawProject> {
  const abs = resolve(path);
  if (!isAbsolute(abs) || !existsSync(abs)) throw new Error(`${abs} does not exist`);
  if (!isGitRepo(abs)) throw new Error(`${abs} is not a git repository`);
  const guess = await guessProject(abs);
  const pkgName = (() => {
    try {
      return (JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8')) as { name?: string }).name;
    } catch {
      return undefined;
    }
  })();
  return {
    id: projectId(abs, existing.map((p) => p.id)),
    name: pkgName && !pkgName.startsWith('@') ? pkgName : basename(abs),
    path: abs,
    baseBranch: guess.baseBranch,
    releaseBranch: guess.baseBranch === 'staging' ? 'main' : guess.baseBranch,
    checks: guess.checks,
  };
}

/** Adds the folder to the config file (no-op if it is already there). Returns the project. */
export async function addProject(configFile: string, path: string): Promise<{ project: RawProject; added: boolean }> {
  const raw = readRawConfig(configFile);
  const found = findProject(raw, path);
  if (found) return { project: found, added: false };
  const project = await projectFromFolder(path, raw.projects ?? []);
  writeRawConfig(configFile, { ...raw, projects: [...(raw.projects ?? []), project] });
  return { project, added: true };
}

/** Removes a project from the list (its tasks and history stay in the event log). */
export function removeProject(configFile: string, id: string): void {
  const raw = readRawConfig(configFile);
  const projects = (raw.projects ?? []).filter((p) => p.id !== id);
  if (projects.length === (raw.projects ?? []).length) throw new Error(`No project ${id}`);
  if (!projects.length) throw new Error('Keep at least one project');
  writeRawConfig(configFile, {
    ...raw,
    projects,
    schedules: (raw.schedules ?? []).filter((s) => s.project !== id),
  });
}
