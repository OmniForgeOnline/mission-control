import { updateRun, listAllRuns } from "../../core/tasks/runs.ts";
import { pauseTask } from "../../core/tasks/tasks.ts";
import { abortInflightTurn } from "../../runtime/sessions.ts";

/** Stop a run: abort its inflight turn if present, then mark run and task paused. */
export async function stopRun(root: string, runId: string): Promise<{ killed: boolean; aborted: boolean }> {
  const run = (await listAllRuns(root)).find((candidate) => candidate.id === runId);
  const taskId = run?.taskId;
  const aborted = taskId ? abortInflightTurn(taskId) : false;

  const completedAt = new Date().toISOString();
  if (run) {
    await updateRun(root, runId, { status: "paused", completedAt, blockedReason: "Stopped by user" });
  }
  if (taskId) {
    await pauseTask(root, taskId, { completedAt, blockedReason: "Stopped by user", runId });
  }
  return { killed: true, aborted };
}
