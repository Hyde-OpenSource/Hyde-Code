// Devflow rules as code (docs/plan.md, "Isolation, safety and permissions"). A rule written
// only in a prompt is a request; these are enforced by CLI flags and a git hook.

export const PROTECTED_BRANCHES = ['main', 'master', 'staging', 'production', 'prod', 'release'] as const;

export function isProtectedBranch(name: string): boolean {
  const short = name.replace(/^refs\/heads\//, '');
  return (PROTECTED_BRANCHES as readonly string[]).includes(short);
}

export interface PermissionProfile {
  role: string;
  /** Tool patterns allowed without a prompt (Claude Code permission rule syntax). */
  allow: string[];
  /** Tool patterns always denied. */
  deny: string[];
}

// In Phase 0 the harness does every push, so agents never need `git push` at all.
const ALWAYS_DENY = [
  'Bash(git push:*)',
  'Bash(git push *)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(git reset --hard:*)',
  'Bash(git checkout main:*)',
  'Bash(git checkout staging:*)',
  'Bash(git switch main:*)',
  'Bash(git switch staging:*)',
  'Bash(git branch -D:*)',
  'Bash(git commit --no-verify:*)',
  'Bash(rm -rf:*)',
  'Bash(sudo:*)',
  'Read(./.env)',
  'Read(./.env.*)',
];

/** Default profile for an implementation agent working in its own worktree. */
export const DEFAULT_DEV_PROFILE: PermissionProfile = {
  role: 'developer',
  allow: [
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    'mcp__hyde__*',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git add:*)',
    'Bash(git commit:*)',
    'Bash(ls:*)',
    'Bash(npm test:*)',
    'Bash(npm run:*)',
    'Bash(pnpm test:*)',
    'Bash(pnpm run:*)',
    'Bash(npx vitest:*)',
    'Bash(node:*)',
  ],
  deny: ALWAYS_DENY,
};

export function compileProfile(profile: PermissionProfile): { allow: string[]; deny: string[] } {
  return { allow: [...profile.allow], deny: [...new Set([...ALWAYS_DENY, ...profile.deny])] };
}

export const HOOK_MARKER = '# hyde-code: protected-branch guard';

/**
 * A pre-push hook that refuses pushes to protected branches. The merge gate (a later phase)
 * sets HYDE_ALLOW_PROTECTED_PUSH=1 for the one push the owner approved.
 */
export function prePushHook(): string {
  const names = PROTECTED_BRANCHES.join('|');
  return `#!/bin/sh
${HOOK_MARKER}
# Refuses pushes to protected branches unless the owner approved it through the harness.
[ "$HYDE_ALLOW_PROTECTED_PUSH" = "1" ] && exit 0
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/${names.replaceAll('|', '|refs/heads/')})
      echo "hyde-code: push to protected branch $remote_ref refused (devflow rule)." >&2
      exit 1
      ;;
  esac
done
exit 0
`;
}
