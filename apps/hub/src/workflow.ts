import { git } from '@hyde/workspace';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ProjectConfig } from './config.ts';

// Per-repo settings in WORKFLOW.md at the repo root, as in Symphony: YAML front matter for
// settings, a prompt template for the body. Read from the base branch, so a task branch can't
// change the rules it runs under.

const frontMatterSchema = z
  .object({
    agents: z.object({ allowed: z.array(z.string()).optional() }).optional(),
    checks: z.array(z.string()).optional(),
    preview: z
      .object({ command: z.string(), url: z.string().optional(), paths: z.array(z.string()).optional() })
      .optional(),
    protectedBranches: z.array(z.string()).optional(),
  })
  .passthrough();

export interface Workflow {
  project: ProjectConfig;
  /** Prompt template body, with {{ task.title }}, {{ task.doneWhen }}, {{ project.name }}. */
  template: string;
}

export function parseWorkflow(text: string): { settings: z.output<typeof frontMatterSchema>; template: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { settings: {}, template: text.trim() };
  const settings = frontMatterSchema.parse(parseYaml(m[1]!) ?? {});
  return { settings, template: m[2]!.trim() };
}

/** The project config with WORKFLOW.md applied. The config file wins where both set a value. */
export function applyWorkflow(project: ProjectConfig, text: string | null): Workflow {
  if (!text) return { project, template: '' };
  const { settings, template } = parseWorkflow(text);
  const merged: ProjectConfig = { ...project };
  if (!project.checks.length && settings.checks) merged.checks = settings.checks;
  if (!project.preview && settings.preview) {
    merged.preview = {
      command: settings.preview.command,
      url: settings.preview.url ?? 'http://127.0.0.1:$PORT',
      paths: settings.preview.paths ?? ['/'],
    };
  }
  if (!project.agents && settings.agents?.allowed) merged.agents = settings.agents.allowed;
  if (!project.protectedBranches && settings.protectedBranches) merged.protectedBranches = settings.protectedBranches;
  return { project: merged, template };
}

export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');
}

export async function readWorkflow(project: ProjectConfig): Promise<Workflow> {
  const text = await git(project.path, ['show', `${project.baseBranch}:WORKFLOW.md`]).catch(() => null);
  return applyWorkflow(project, text);
}
