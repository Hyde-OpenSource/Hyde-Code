import { join } from 'node:path';

export { LocalHost, type CommandResult, type HostOps, type PullRequest } from '@hyde/workspace';

export function worktreesRoot(dataDir: string, projectId: string): string {
  return join(dataDir, 'worktrees', projectId);
}
