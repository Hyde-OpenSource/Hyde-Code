import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile, HarnessState, TaskView } from '@hyde/core';

// The devflow files as live projections of the event log (docs/plan.md: "every devflow file
// becomes a live table that is still written back"). The hub is the single writer.

const STATUS: Record<string, string> = {
  backlog: 'TODO',
  clarifying: 'TODO',
  ready: 'TODO',
  running: 'IN PROGRESS',
  verifying: 'IN PROGRESS',
  review: 'REVIEW',
  awaiting_merge: 'REVIEW',
  done: 'DONE',
  blocked: 'BLOCKED',
  failed: 'BLOCKED',
  cancelled: 'DONE',
};

const PRIORITY = ['high', 'high', 'medium', 'low', 'low'];

function taskBlock(t: TaskView): string {
  const blocked = t.status === 'blocked' && t.blockedBy ? `BLOCKED (${t.blockedBy.id})` : STATUS[t.status];
  const notes = t.statusHistory.slice(-3).reverse().map((h) => `${h.ts.slice(0, 16).replace('T', ' ')} ${h.to}${h.reason ? `: ${h.reason}` : ''}`);
  return [
    `## ${t.id}: ${t.title}`,
    `- **Assigned to:** ${t.agent ?? t.pinnedAgent ?? 'router'}`,
    `- **Assigned by / date:** hyde-hub on ${t.createdTs.slice(0, 10)}`,
    `- **Priority:** ${PRIORITY[t.priority] ?? 'medium'}`,
    `- **Repeats:** ${t.source.kind === 'schedule' ? 'scheduled' : 'once'}`,
    `- **Files / area:** ${t.writeScope.length ? t.writeScope.join(', ') : 'any'}`,
    `- **Branch:** ${t.branch ?? 'not created yet'}`,
    `- **Status:** ${blocked}`,
    `- **Done when:** ${t.doneWhen ?? t.spec.split('\n')[0]}`,
    `- **Notes:** ${notes.join('; ') || 'none'}${t.prUrl ? `; PR ${t.prUrl}` : ''}`,
  ].join('\n');
}

export function renderTasks(state: HarnessState, projectId: string): string {
  const tasks = [...state.tasks.values()].filter((t) => t.projectId === projectId);
  const active = tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
  const finished = tasks.filter((t) => ['done', 'cancelled'].includes(t.status));
  return [
    '# Tasks',
    '',
    '> Rendered by the Hyde Code hub from its event log. Edit tasks through the hub, not this file.',
    '',
    '## Active tasks',
    '',
    ...active.map((t) => taskBlock(t) + '\n'),
    '## Done',
    '',
    ...finished.map((t) => taskBlock(t) + '\n'),
  ].join('\n');
}

export function renderAgents(state: HarnessState, agents: AgentProfile[]): string {
  const rows = agents.map((a) => {
    const runs = [...state.runs.values()].filter((r) => r.agent === a.name);
    const live = runs.find((r) => r.state === 'running');
    const last = runs.at(-1);
    const task = live ? state.tasks.get(live.taskId) : undefined;
    return `| ${a.name} | ${last?.model ?? a.model ?? 'default'} (${a.adapter}) | child | ${a.roles.join(', ')} | ${a.enabled ? (live ? 'working' : 'online') : 'disabled'} | ${task?.branch ?? '-'} | ${last?.lastEventTs.slice(0, 16).replace('T', ' ') ?? '-'} |`;
  });
  return [
    '# Agents',
    '',
    '> Rendered by the Hyde Code hub. The hub is the main agent; these are the child agents it runs.',
    '',
    '## Registry',
    '',
    '| Agent name | Model | Type | Role | Status | Branch | Last seen |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

export function renderQuestions(state: HarnessState, projectId: string): { questions: string; answers: string } {
  const qs = [...state.questions.values()].filter((q) => state.tasks.get(q.taskId)?.projectId === projectId);
  const questions = [
    '# Agent Questions',
    '',
    '> Rendered by the Hyde Code hub. Answer in chat or the dashboard.',
    '',
    '## Questions',
    '',
    ...qs.map((q) => {
      const run = state.runs.get(q.runId);
      return [
        `## ${q.id}: ${q.text.split('\n')[0]!.slice(0, 80)}`,
        `- **From:** ${run?.agent ?? 'agent'} (${run?.model ?? 'unknown'})`,
        `- **Date:** ${q.askedTs.slice(0, 16).replace('T', ' ')}`,
        `- **Related task:** ${q.taskId}`,
        `- **Status:** ${q.status === 'open' ? 'OPEN' : 'ANSWERED'}`,
        `- **Question:** ${q.text}`,
        `- **Blocking?:** ${q.blocking ? 'yes' : 'no'}`,
        '',
      ].join('\n');
    }),
  ].join('\n');
  const answers = [
    '# Agent Answers',
    '',
    '> Rendered by the Hyde Code hub.',
    '',
    '## Answers',
    '',
    ...qs
      .filter((q) => q.status === 'answered')
      .map((q) =>
        [
          `## ${q.id}: ${q.text.split('\n')[0]!.slice(0, 80)}`,
          `- **Asked by:** ${state.runs.get(q.runId)?.agent ?? 'agent'} on ${q.askedTs.slice(0, 10)}`,
          `- **Question:** ${q.text}`,
          `- **Answer:** ${q.answer}`,
          `- **Answered by:** ${q.answeredBy} (source: owner)`,
          '- **Follow-up:** delivered to the agent session',
          '',
        ].join('\n'),
      ),
  ].join('\n');
  return { questions, answers };
}

export function renderReports(state: HarnessState, projectId: string): string {
  const incidents = [...state.incidents.values()].filter((i) => !i.taskId || state.tasks.get(i.taskId)?.projectId === projectId);
  return [
    '# Reports',
    '',
    '> Rendered by the Hyde Code hub: incidents raised by agents or by the harness itself.',
    '',
    '## Reports',
    '',
    ...incidents.map((i) =>
      [
        `## ${i.id}: ${i.about}`,
        `- **Reported by:** hyde-hub on ${i.ts.slice(0, 16).replace('T', ' ')}`,
        `- **About:** ${i.taskId ?? 'system'}`,
        `- **Evidence:** ${i.evidence.replaceAll('\n', ' ').slice(0, 500)}`,
        '- **Status:** OPEN',
        '',
      ].join('\n'),
    ),
  ].join('\n');
}

/** Writes all projections for one project into `dir` (the hub's data dir, never a protected branch). */
export function writeDevflowFiles(dir: string, state: HarnessState, projectId: string, agents: AgentProfile[]): void {
  mkdirSync(dir, { recursive: true });
  const { questions, answers } = renderQuestions(state, projectId);
  const files: Record<string, string> = {
    'tasks.md': renderTasks(state, projectId),
    'agents.md': renderAgents(state, agents),
    'AgentQuestions.md': questions,
    'AgentAnswers.md': answers,
    'report.md': renderReports(state, projectId),
  };
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text);
  }
}

const LESSONS_HEADING = '## Lessons learned';

/**
 * Adds approved lessons to CLAUDE.md and mirrors them into AGENTS.md so Codex and other agents read
 * them too. Creates the section (or file) when missing; skips lines already present.
 */
export function writeLessons(repoDir: string, lessons: string[]): string[] {
  const touched: string[] = [];
  for (const name of LESSON_FILES) {
    const path = join(repoDir, name);
    const next = withLessons(existsSync(path) ? readFileSync(path, 'utf8') : null, name, lessons);
    if (next === null) continue;
    writeFileSync(path, next);
    touched.push(name);
  }
  return touched;
}

export const LESSON_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/** The file text with the lessons added to its Lessons learned section, or null if nothing changes. */
export function withLessons(current: string | null, name: string, lessons: string[]): string | null {
  let text = current ?? `# ${name.replace('.md', '')}\n`;
  const fresh = lessons.filter((l) => !text.includes(l));
  if (!fresh.length) return null;
  if (!text.includes(LESSONS_HEADING)) text = `${text.trimEnd()}\n\n${LESSONS_HEADING}\n`;
  const at = text.indexOf(LESSONS_HEADING) + LESSONS_HEADING.length;
  const next = text.slice(at).search(/\n#{1,2} /);
  const end = next === -1 ? text.length : at + next;
  const section = text.slice(at, end).trimEnd();
  return `${text.slice(0, at)}${section}\n${fresh.join('\n')}\n${text.slice(end)}`;
}
