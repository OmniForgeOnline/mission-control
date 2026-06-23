import { runTaskTurn } from "../../daemon/processor.ts";
import type { ProcessOptions } from "../../daemon/types.ts";
import { listTasks, updateTask } from "../tasks/tasks.ts";
import { listAllRuns, updateRun } from "../tasks/runs.ts";
import {
  isGitWorkflow,
  isPostPushWorkflowStep,
  loadWorkflow
} from "../workflows/index.ts";
import type { HarnessTask } from "../types.ts";
import type { WorkflowDefinition } from "../workflows/types.ts";

function now(): string {
  return new Date().toISOString();
}

function isRepoBackedTask(task: HarnessTask): boolean {
  return Boolean(task.repoPath && task.branch);
}

/**
 * Repo-backed tasks that pushed but remain on a post-push step before review.
 */
export function isStuckPushedPreReviewTask(
  task: HarnessTask,
  workflow: WorkflowDefinition
): boolean {
  if (!task.workflowRun) return false;
  if (task.resolution || task.blockedReason || task.pausedAt || task.interruptedAt) return false;
  if (!task.pushedAt) return false;
  if (!isRepoBackedTask(task)) return false;
  if (!isGitWorkflow(workflow)) return false;

  const stepId = task.workflowRun.currentStepId;
  const step = workflow.steps[stepId];
  if (!step) return false;
  if (step.kind === "review" || step.kind === "terminal") return false;

  return isPostPushWorkflowStep(workflow, stepId);
}

export interface ReconcileStuckPushedTasksResult {
  scanned: number;
  reconciled: number;
  errors: number;
}

/**
 * Scan repo-backed tasks stuck after push on pre-review workflow steps and
 * chain advancement via `runTaskTurn`.
 */
export async function reconcileStuckPushedTasks(
  root: string,
  options?: ProcessOptions
): Promise<ReconcileStuckPushedTasksResult> {
  const tasks = await listTasks(root);
  let scanned = 0;
  let reconciled = 0;
  let errors = 0;

  for (const task of tasks) {
    if (!task.workflowRun || !task.pushedAt) continue;
    if (task.resolution || task.blockedReason || task.pausedAt || task.interruptedAt) continue;
    if (!isRepoBackedTask(task)) continue;

    let workflow: WorkflowDefinition;
    try {
      workflow = await loadWorkflow(root, task.workflowRun.workflowId);
    } catch {
      errors++;
      continue;
    }

    if (!isStuckPushedPreReviewTask(task, workflow)) continue;

    scanned++;
    try {
      const result = await runTaskTurn(root, task.id, options);
      if (result) reconciled++;
    } catch {
      errors++;
    }
  }

  return { scanned, reconciled, errors };
}

/**
 * At startup the in-flight map is empty by definition, so any task still in
 * `running` is orphaned from a previous harness process that went down mid-turn.
 * Flip each to `interrupted`, mark its run, and clear `currentActivity`.
 */
export async function reconcileInterruptedTasks(root: string): Promise<{ reconciled: number }> {
  const [tasks, runs] = await Promise.all([listTasks(root), listAllRuns(root)]);
  let reconciled = 0;
  for (const task of tasks) {
    const runningRuns = runs.filter((candidate) => candidate.taskId === task.id && candidate.status === "running");
    if (runningRuns.length === 0) continue;
    if (!task.pausedAt && !task.interruptedAt && !task.resolution) {
      await updateTask(root, task.id, (t) => {
        const { currentActivity: _activity, ...rest } = t;
        return {
          ...rest,
          interruptedAt: now(),
          updatedAt: now()
        };
      });
    }
    for (const run of runningRuns) {
      await updateRun(root, run.id, {
        status: "interrupted",
        completedAt: now(),
        blockedReason: "Harness went down while task was running"
      }).catch(() => {
        /* run may not exist */
      });
    }
    reconciled++;
  }
  return { reconciled };
}
