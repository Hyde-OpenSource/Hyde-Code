import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuestionView, TaskView } from '@hyde/core';

// The devflow files as harness projections: the hub writes them, agents propose changes
// through the harness tools (single-writer rule, docs/plan.md "Your devflow-skills become the pipeline").

/** Set in every agent's environment so the devflow skills skip the interactive "main or child?" step. */
export const HARNESS_ENV = { DEVFLOW_HARNESS: '1' } as const;

export interface PacketInput {
  task: TaskView;
  agent: string;
  model: string;
  branch: string;
  baseBranch: string;
  projectName: string;
  answers: QuestionView[];
  lessons: string[];
}

/** The task packet appended to the agent's system prompt. Short on purpose: the repo docs are the record. */
export function buildTaskPacket(input: PacketInput): string {
  const { task } = input;
  const lines = [
    '# Hyde Code task packet',
    '',
    `You are **${input.agent}** (${input.model}), a child agent started by the Hyde Code harness.`,
    `Project: ${input.projectName}. Task: **${task.id}: ${task.title}**.`,
    `Branch: \`${input.branch}\` (cut from \`${input.baseBranch}\`). You are already on it, in your own git worktree.`,
    '',
    '## Task',
    task.spec,
    '',
    '## Rules (devflow, enforced by the harness)',
    '- Work only in this worktree and on this branch. Never push, merge, rebase or switch branches; the harness pushes after the owner approves.',
    '- Never assume. If something is unclear, call the `ask_question` tool. Blocking question: call it, then end your turn; you will be resumed with the answer.',
    '- Read the related code before editing. Follow the project conventions. Small, focused changes.',
    '- Verify your change (run the tests or the code). Commit in small logical steps with messages that say what and why.',
    '- Do not edit progress.md, tasks.md or agents.md; the harness writes them from your report.',
    '- Remove any temporary files you create.',
    '- When done, call `complete_task` with a summary, how you verified it, and the files you changed.',
  ];
  if (input.answers.length) {
    lines.push('', '## Earlier answers from the owner');
    for (const q of input.answers) lines.push(`- ${q.id}: ${q.text} → **${q.answer}**`);
  }
  if (input.lessons.length) {
    lines.push('', '## Recent lessons');
    for (const lesson of input.lessons) lines.push(lesson);
  }
  return lines.join('\n') + '\n';
}

/** Lesson lines (`- YYYY-MM-DD: ...`) from the Lessons learned section of CLAUDE.md, newest last. */
export function readLessons(repoDir: string, limit = 10): string[] {
  const path = join(repoDir, 'CLAUDE.md');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const after = text.split(/^## Lessons learned\s*$/m)[1] ?? '';
  const section = after.split(/^#{1,2} /m)[0] ?? '';
  return section
    .split('\n')
    .filter((l) => /^- \d{4}-\d{2}-\d{2}:/.test(l))
    .slice(-limit);
}

export interface ProgressEntry {
  date: string;
  title: string;
  agent: string;
  model: string;
  branch: string;
  what: string;
  why: string;
  files: string[];
  verified: string;
  followUps: string;
}

export function renderProgressEntry(e: ProgressEntry): string {
  return [
    `### ${e.date}: ${e.title}`,
    `- **Agent:** ${e.agent} (${e.model})`,
    `- **Branch:** ${e.branch}`,
    `- **What:** ${e.what}`,
    `- **Why:** ${e.why}`,
    `- **Files:** ${e.files.length ? e.files.join(', ') : 'none'}`,
    `- **Verified:** ${e.verified}`,
    `- **Open / follow-ups:** ${e.followUps || 'none'}`,
  ].join('\n');
}

const LOG_MARKER = '<!-- New entries go directly below this line, newest first. -->';

/**
 * Adds an entry to progress.md if the repo uses devflow: directly below the Log marker
 * (newest first), or at the end when the marker is missing. Returns false when there is no progress.md.
 */
export function addProgressEntry(repoDir: string, entry: ProgressEntry): boolean {
  const path = join(repoDir, 'progress.md');
  if (!existsSync(path)) return false;
  const current = readFileSync(path, 'utf8');
  const block = renderProgressEntry(entry);
  const at = current.indexOf(LOG_MARKER);
  if (at === -1) {
    writeFileSync(path, `${current}${current.endsWith('\n') ? '' : '\n'}\n${block}\n`);
  } else {
    const end = at + LOG_MARKER.length;
    writeFileSync(path, `${current.slice(0, end)}\n${block}\n${current.slice(end)}`);
  }
  return true;
}
