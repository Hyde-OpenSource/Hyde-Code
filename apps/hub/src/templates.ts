import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Task templates (docs/roadmap-v2.md section 5): `.hyde/commands/<name>.md` in a project, or
// `~/.hyde/commands/<name>.md` for every project. Front matter: description, level, agent.
// The body becomes the task text, with $ARGUMENTS replaced. Every intake (chat, CLI, web,
// Hyde AI) reaches them through the same `/run <name> …` command.

export interface Template {
  name: string;
  description: string;
  body: string;
  level?: 'trivial' | 'low' | 'medium' | 'high';
  agent?: string;
  source: 'project' | 'user';
}

const LEVELS = ['trivial', 'low', 'medium', 'high'];

export function parseTemplate(name: string, text: string, source: Template['source']): Template {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const body = (m ? m[2]! : text).trim();
  return {
    name,
    description: meta.description || body.split('\n')[0]!.slice(0, 100),
    body,
    source,
    ...(meta.level && LEVELS.includes(meta.level) && { level: meta.level as Template['level'] }),
    ...(meta.agent && { agent: meta.agent }),
  };
}

function readDir(dir: string, source: Template['source']): Template[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[a-z0-9][a-z0-9-]*\.md$/.test(f))
    .map((f) => parseTemplate(f.slice(0, -3), readFileSync(join(dir, f), 'utf8'), source));
}

/** Project templates win over the owner's own ones with the same name. */
export function loadTemplates(projectPath: string, userDir: string): Template[] {
  const byName = new Map<string, Template>();
  for (const t of readDir(userDir, 'user')) byName.set(t.name, t);
  for (const t of readDir(join(projectPath, '.hyde', 'commands'), 'project')) byName.set(t.name, t);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandTemplate(t: Template, args: string): string {
  if (t.body.includes('$ARGUMENTS')) return t.body.replaceAll('$ARGUMENTS', args);
  return args ? `${t.body}\n\n${args}` : t.body;
}
