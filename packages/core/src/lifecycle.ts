import type { TaskStatus } from './events.ts';

// Allowed task transitions (docs/plan.md, "The orchestrator brain"). Code decides control
// flow; anything not listed here is a bug and is refused.
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['clarifying', 'ready', 'cancelled'],
  clarifying: ['ready', 'blocked', 'cancelled'],
  ready: ['running', 'blocked', 'cancelled'],
  running: ['ready', 'verifying', 'blocked', 'failed', 'cancelled'],
  verifying: ['ready', 'running', 'review', 'awaiting_merge', 'blocked', 'failed', 'cancelled'],
  review: ['running', 'awaiting_merge', 'blocked', 'cancelled'],
  // Only the owner's merge tap moves a task to done.
  awaiting_merge: ['running', 'done', 'blocked', 'cancelled'],
  done: [],
  blocked: ['ready', 'running', 'verifying', 'awaiting_merge', 'failed', 'cancelled'],
  failed: ['ready', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'cancelled'];

/** Retry delay after a failed run: min(10 s × 2^(attempt − 1), 5 min). */
export function retryDelayMs(attempt: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
}
