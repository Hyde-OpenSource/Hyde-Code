import type { HarnessEventRecord, HarnessState } from '@hyde/core';

// Session export (docs/roadmap-v2.md section 5): one task as Markdown or HTML, built from the
// event log, with anything that looks like a secret redacted.

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
/** `password: x`, `token=x`, `Bearer x`: keep the label, hide the value. */
const LABELLED = /\b(Bearer|token|apikey|api_key|password|secret)(["'\s:=]+)[^\s"']{8,}/gi;

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out.replace(LABELLED, (_m, label: string, sep: string) => `${label}${sep}[redacted]`);
}

function line(e: HarnessEventRecord): string | null {
  const p = e.payload as Record<string, any>;
  const t = e.ts.slice(0, 19).replace('T', ' ');
  switch (e.type) {
    case 'task.status_changed':
      return `${t} → **${p.to}**${p.reason ? ` (${p.reason})` : ''}`;
    case 'task.classified':
      return `${t} complexity ${p.level} by ${p.by}: ${p.reason}`;
    case 'run.dispatched':
      return `${t} ${p.runId} ${p.mode} on ${p.agent}${p.model ? ` (${p.model}${p.effort ? `, effort ${p.effort}` : ''})` : ''}`;
    case 'run.event': {
      const ev = p.event ?? {};
      if (ev.type === 'tool.started') return `${t} ${p.runId} ▸ ${ev.tool}: ${String(ev.summary).slice(0, 200)}`;
      if (ev.type === 'run.failed') return `${t} ${p.runId} ✗ ${ev.reason}${ev.detail ? `: ${String(ev.detail).slice(0, 200)}` : ''}`;
      if (ev.type === 'usage') return `${t} ${p.runId} tokens ${ev.inputTokens} in / ${ev.outputTokens} out`;
      return null;
    }
    case 'question.asked':
      return `${t} ❓ ${p.questionId}: ${p.text}`;
    case 'question.answered':
      return `${t} ✔ ${p.questionId} answered: ${p.answer}`;
    case 'approval.requested':
      return `${t} 🔐 ${p.approvalId} (${p.kind}): ${p.summary}`;
    case 'approval.decided':
      return `${t} ${p.approvalId} ${p.approved ? 'approved' : 'denied'}`;
    case 'task.agent_completed':
      return `${t} agent reported done: ${p.summary}`;
    case 'task.review_finished':
      return `${t} review by ${p.reviewer}: ${p.verdict}. ${p.summary}`;
    case 'browser.action':
      return `${t} browser ${p.step}: ${p.label}`;
    case 'task.comment_added':
      return `${t} 💬 ${p.file}${p.line ? `:${p.line}` : ''}: ${p.text}`;
    case 'task.undone':
      return `${t} ↩ undid ${p.runId}`;
    case 'task.pr_opened':
      return `${t} PR ${p.url}`;
    default:
      return null;
  }
}

export function exportMarkdown(state: HarnessState, taskId: string, events: HarnessEventRecord[]): string {
  const task = state.tasks.get(taskId);
  if (!task) throw new Error(`No task ${taskId}`);
  const runs = task.runIds.map((id) => state.runs.get(id)!).filter(Boolean);
  const out = [
    `# ${task.id}: ${task.title}`,
    '',
    `- **Project:** ${task.projectId}  ·  **Status:** ${task.status}  ·  **Complexity:** ${task.complexity?.level ?? 'unrated'}`,
    task.branch ? `- **Branch:** ${task.branch}` : '',
    task.prUrl ? `- **PR:** ${task.prUrl}` : '',
    '',
    '## Request',
    '',
    task.spec,
    task.doneWhen ? `\n**Done when:** ${task.doneWhen}` : '',
    task.todos.length ? `\n## Checklist\n\n${task.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')}` : '',
    task.assumptions.length ? `\n## Assumptions\n\n${task.assumptions.map((a) => `- ${a}`).join('\n')}` : '',
    '',
    '## Runs',
    '',
    '| Run | Mode | Agent | Model | Tokens in/out | Cost |',
    '|---|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.id} | ${r.mode} | ${r.agent} | ${r.model ?? r.requestedModel ?? ''} | ${r.inputTokens}/${r.outputTokens} | ${r.costUsd ? `$${r.costUsd.toFixed(3)}` : ''} |`),
    task.completion ? `\n## Result\n\n${task.completion.summary}\n\n**Verified:** ${task.completion.verified}` : '',
    '',
    '## Timeline',
    '',
    ...events.map(line).filter((l): l is string => l !== null).map((l) => `- ${l}`),
    '',
    '_Exported by Hyde Code from the event log. Secrets are redacted._',
  ];
  let text = redact(out.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'));
  // Branch names are made from the title, so a secret in the request is in the branch too.
  if (task.branch && redact(`${task.title}\n${task.spec}`) !== `${task.title}\n${task.spec}`) {
    text = text.replaceAll(task.branch, task.branch.replace(/(\/t-\d+)-.*$/, '$1-[redacted]'));
  }
  return text + '\n';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A self-contained HTML page of the same export (the Markdown, escaped, in a readable page). */
export function exportHtml(state: HarnessState, taskId: string, events: HarnessEventRecord[]): string {
  const md = exportMarkdown(state, taskId, events);
  const title = escapeHtml(md.split('\n')[0]!.replace(/^# /, ''));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1b1b1b;background:#fffdf6}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><pre>${escapeHtml(md)}</pre></body></html>\n`;
}
