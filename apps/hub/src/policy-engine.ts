import { isAbsolute, relative, resolve } from 'node:path';
import { isProtectedBranch } from '@hyde/policy';

// Devflow rules as code (docs/plan.md "Policy engine"): the Claude PreToolUse hook asks the hub
// about every risky tool call. Prompts are requests; this is the boundary.

export interface PolicyInput {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  writeScope: string[];
  approvalRequired: string[];
  /** Commands the owner already approved for this task. */
  approvedCommands: string[];
}

export type PolicyDecision =
  | { decision: 'allow'; rule: string }
  | { decision: 'deny'; rule: string; reason: string }
  | { decision: 'approval'; rule: 'new-dependency' | 'destructive'; reason: string };

const INSTALL = /\b(npm (i|install|add)|pnpm (add|install)|yarn add|bun add|pip3? install|poetry add|cargo add|go get|gem install|composer require)\b(?!\s*$)/;
const INSTALL_BARE = /\b(npm (ci|install|i)|pnpm install|yarn( install)?|bun install|pip3? install -r)\s*($|&&|;|\|)/;
const DESTRUCTIVE = /\b(rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|git\s+clean\s+-[a-z]*f|git\s+reset\s+--hard|drop\s+(table|database)|mkfs|dd\s+if=)/i;

function matchesGlob(path: string, glob: string): boolean {
  const re = new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*') +
      '$',
  );
  return re.test(path);
}

export function inWriteScope(cwd: string, file: string, scope: string[]): boolean {
  if (!scope.length) return true;
  const rel = relative(cwd, resolve(cwd, file));
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  // The harness writes these; agents may still touch tests next to their scope via the scope itself.
  return scope.some((g) => matchesGlob(rel, g) || matchesGlob(rel, g.replace(/\/\*\*$/, '')));
}

/** Push/merge targets named in a git command line. */
function gitTargets(command: string): { verb: string; refs: string[] }[] {
  const out: { verb: string; refs: string[] }[] = [];
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const m = /\bgit\s+(?:-C\s+\S+\s+)?(push|merge|rebase|checkout|switch|reset|branch)\b(.*)/.exec(part.trim());
    if (!m) continue;
    const refs = m[2]!
      .trim()
      .split(/\s+/)
      .filter((t) => t && !t.startsWith('-'))
      .flatMap((t) => t.split(':'))
      .map((t) => t.replace(/^\+/, '').replace(/^origin\//, ''));
    out.push({ verb: m[1]!, refs });
  }
  return out;
}

export function decide(p: PolicyInput): PolicyDecision {
  const command = typeof p.input.command === 'string' ? p.input.command : '';
  if (p.tool === 'Bash' && command) {
    for (const { verb, refs } of gitTargets(command)) {
      if (verb === 'push') return { decision: 'deny', rule: 'no-push', reason: 'Agents never push; the harness pushes after the owner approves.' };
      if (verb === 'merge' || verb === 'rebase') {
        return { decision: 'deny', rule: `no-${verb}`, reason: `git ${verb} is reserved for the harness merge queue.` };
      }
      if ((verb === 'checkout' || verb === 'switch') && refs.some(isProtectedBranch)) {
        return { decision: 'deny', rule: 'protected-branch', reason: 'Stay on your task branch; protected branches are off limits.' };
      }
      if (verb === 'branch' && /\s-D\b|\s--delete\b/.test(command)) {
        return { decision: 'deny', rule: 'no-branch-delete', reason: 'Deleting branches is not allowed.' };
      }
    }
    if (/--no-verify\b/.test(command)) return { decision: 'deny', rule: 'no-skip-hooks', reason: 'Skipping hooks is not allowed.' };
    if (/\bsudo\b/.test(command)) return { decision: 'deny', rule: 'no-sudo', reason: 'sudo is not allowed.' };
    if (DESTRUCTIVE.test(command)) {
      if (p.approvalRequired.includes('destructive') && !p.approvedCommands.includes(command)) {
        return { decision: 'approval', rule: 'destructive', reason: `Destructive command needs the owner's approval: ${command}` };
      }
      if (!p.approvalRequired.includes('destructive')) {
        return { decision: 'deny', rule: 'destructive', reason: 'Destructive commands are not allowed.' };
      }
    }
    if (INSTALL.test(command) && !INSTALL_BARE.test(command) && p.approvalRequired.includes('new-dependency')) {
      if (!p.approvedCommands.includes(command)) {
        return { decision: 'approval', rule: 'new-dependency', reason: `Adding a dependency needs the owner's approval: ${command}` };
      }
    }
    return { decision: 'allow', rule: 'bash' };
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(p.tool)) {
    const file = String(p.input.file_path ?? p.input.notebook_path ?? '');
    const rel = relative(p.cwd, resolve(p.cwd, file));
    if (rel.startsWith('..') || isAbsolute(rel)) return { decision: 'deny', rule: 'outside-worktree', reason: `Write outside the task worktree: ${file}` };
    if (/(^|\/)\.env(\.|$)/.test(rel)) return { decision: 'deny', rule: 'env-file', reason: '.env files are off limits.' };
    if (['progress.md', 'tasks.md', 'agents.md'].includes(rel)) {
      return { decision: 'deny', rule: 'single-writer', reason: `${rel} is written by the harness; report through complete_task.` };
    }
    if (!inWriteScope(p.cwd, file, p.writeScope)) {
      return { decision: 'deny', rule: 'write-scope', reason: `${rel} is outside this task's write scope (${p.writeScope.join(', ')}). Ask with ask_question if you need it.` };
    }
    return { decision: 'allow', rule: 'edit' };
  }
  return { decision: 'allow', rule: 'other' };
}

/** The response body Claude Code's HTTP PreToolUse hook expects. */
export function hookResponse(d: PolicyDecision): Record<string, unknown> {
  if (d.decision === 'allow') return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        d.decision === 'approval'
          ? `${d.reason} The owner has been asked. End your turn now; you will be resumed when they decide.`
          : d.reason,
    },
  };
}
