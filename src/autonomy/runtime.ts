import { listAllRuns } from "../core/tasks/runs.ts";
import type { AutonomyJob } from "./job-types.ts";

const inflightJobIds = new Set<string>();

export function markAutonomyJobRunning(jobId: string): void {
  inflightJobIds.add(jobId);
}

export function clearAutonomyJobRunning(jobId: string): void {
  inflightJobIds.delete(jobId);
}

export type AutonomyJobWithRuntime = AutonomyJob & {
  isRunning: boolean;
  activeRunId?: string;
};

export async function attachAutonomyJobRuntime(
  root: string,
  jobs: AutonomyJob[]
): Promise<AutonomyJobWithRuntime[]> {
  const runs = await listAllRuns(root);
  const runningRunByJobId = new Map<string, string>();
  for (const run of runs) {
    if (run.status !== "running" || !run.taskId?.startsWith("autonomy:")) continue;
    runningRunByJobId.set(run.taskId.slice("autonomy:".length), run.id);
  }

  const inflight = new Set(inflightJobIds);
  return jobs.map((job) => {
    const activeRunId = runningRunByJobId.get(job.id);
    const isRunning = inflight.has(job.id) || Boolean(activeRunId);
    return {
      ...job,
      isRunning,
      ...(activeRunId ? { activeRunId } : {})
    };
  });
}