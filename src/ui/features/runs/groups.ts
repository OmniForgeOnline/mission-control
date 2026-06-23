import type { HarnessRun } from "@ui/app/types.js";

export interface RunTaskGroup {
  taskId: string;
  taskTitle: string;
  runs: HarnessRun[];
  rollUpStatus: string;
  lastActivityAt: string;
  defaultExpanded: boolean;
}

const ROLL_UP_PRIORITY = ["running", "paused", "blocked"] as const;

/**
 * Daemon-maintenance runs are produced by the cross-cutting autonomy jobs
 * (doc gardening, guidance sweep, worktree cleanup, …). They carry an
 * `autonomy:<job>` task id and have no owning project, so they surface in the
 * System → Maintenance view rather than any project's Runs tab. Per-project
 * autonomy runs use an `autonomy:project:<id>:…` task id and are excluded.
 */
export function isMaintenanceRun(run: HarnessRun): boolean {
  return run.taskId.startsWith("autonomy:") && !run.taskId.startsWith("autonomy:project:");
}

function runActivityAt(run: HarnessRun): string {
  return run.completedAt ?? run.startedAt;
}

export function rollUpRunStatus(runs: HarnessRun[]): string {
  for (const status of ROLL_UP_PRIORITY) {
    if (runs.some((run) => run.status === status)) return status;
  }
  const newest = [...runs].sort((a, b) => runActivityAt(b).localeCompare(runActivityAt(a)))[0];
  return newest?.status ?? "completed";
}

export function groupRunsByTask(runs: HarnessRun[]): RunTaskGroup[] {
  const byTask = new Map<string, HarnessRun[]>();
  for (const run of runs) {
    const list = byTask.get(run.taskId) ?? [];
    list.push(run);
    byTask.set(run.taskId, list);
  }

  const groups: RunTaskGroup[] = [];
  for (const [taskId, taskRuns] of byTask) {
    const sortedRuns = [...taskRuns].sort((a, b) => runActivityAt(b).localeCompare(runActivityAt(a)));
    const lastActivityAt = runActivityAt(sortedRuns[0]!);
    groups.push({
      taskId,
      taskTitle: sortedRuns[0]!.taskTitle,
      runs: sortedRuns,
      rollUpStatus: rollUpRunStatus(sortedRuns),
      lastActivityAt,
      defaultExpanded: false
    });
  }

  return groups.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}
