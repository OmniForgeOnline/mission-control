import type { HarnessTask } from "../../src/core/types.ts";
import { DEFAULT_WORKFLOW_ID, loadWorkflow, type WorkflowDefinition } from "../../src/core/workflows/index.ts";
import {
  effectivePmStatus,
  isAwaitingOperator,
  isAwaitingReview,
  isMergePending,
  isTaskQueuedForApproval,
  isTaskResumable,
  isTaskRunning,
  isTaskTerminal
} from "../../src/core/tasks/status.ts";
import { listInflightTaskIds } from "../../src/runtime/sessions.ts";

/** Test helper mapping legacy status expectations to the three-axis model. */
export function legacyTaskStatus(
  task: HarnessTask,
  workflow: WorkflowDefinition
): string {
  if (task.resolution === "completed") return "completed";
  if (task.resolution === "cancelled") return "cancelled";
  if (task.pausedAt) return "paused";
  if (task.interruptedAt) return "interrupted";
  if (task.blockedReason) return "blocked";
  if (isTaskRunning(task, listInflightTaskIds())) return "running";
  if (isAwaitingOperator(task, workflow)) return "awaiting_operator";
  if (isAwaitingReview(task, workflow)) return "awaiting_review";
  if (isTaskQueuedForApproval(task, workflow)) return "queued";
  if (isTaskTerminal(task, workflow)) {
    return isMergePending(task) ? "awaiting_review" : "completed";
  }
  if (task.mergeRequest && effectivePmStatus(task, workflow) === "in_review") return "pushed";
  if (isTaskResumable(task)) return task.pausedAt ? "paused" : "interrupted";
  return "approved";
}

/** Load workflow and map a task to its legacy status string for test assertions. */
export async function taskLegacyStatus(root: string, task: HarnessTask): Promise<string> {
  const workflowId = task.workflowRun?.workflowId ?? DEFAULT_WORKFLOW_ID;
  const workflow = await loadWorkflow(root, workflowId);
  return legacyTaskStatus(task, workflow);
}