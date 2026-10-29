import { Cron } from 'croner';
import type { Inbound } from '@hyde/core';
import type { ScheduleConfig } from './config.ts';

// Recurring tasks (devflow "Repeats: daily"; docs/plan.md Phase 3 "Schedules"). Each firing
// becomes an ordinary /new command with a command id per minute, so a restart can't double it.

export function startSchedules(
  schedules: ScheduleConfig[],
  submit: (inbound: Inbound) => Promise<unknown>,
  log: (msg: string) => void,
): () => void {
  const jobs = schedules
    .filter((s) => s.enabled)
    .map(
      (s) =>
        new Cron(s.cron, { name: s.id, protect: true }, async () => {
          const minute = new Date().toISOString().slice(0, 16);
          try {
            await submit(scheduleInbound(s, minute));
          } catch (err) {
            log(`schedule ${s.id}: ${(err as Error).message}`);
          }
        }),
    );
  for (const job of jobs) log(`schedule ${job.name}: next run ${job.nextRun()?.toLocaleString() ?? 'never'}`);
  return () => jobs.forEach((j) => j.stop());
}

export function scheduleInbound(s: ScheduleConfig, minute: string): Inbound {
  return {
    command: { kind: 'new', text: s.text, project: s.project, ...(s.agent && { agent: s.agent }) },
    userId: `schedule:${s.id}`,
    gateway: 'schedule',
    chatId: '',
    commandId: `schedule:${s.id}:${minute}`,
  };
}

/** Validates a cron expression (for the settings page). */
export function nextRuns(cron: string, count = 3): string[] {
  const job = new Cron(cron, { paused: true });
  const runs = job.nextRuns(count).map((d) => d.toISOString());
  job.stop();
  return runs;
}
