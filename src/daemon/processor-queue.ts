import {
  inspectPostTurnGit,
  prepareStepWorkspace
} from "../core/worktrees/worktrees.ts";
import {
  advanceTaskWorkflowStep,
  getTask,
  listTasks,
  markTaskBlocked,
  patchTaskExecution,
  routeTaskToImplementationStep
} from "../core/tasks/tasks.ts";
import { listAllRuns } from "../core/tasks/runs.ts";
import {
  isDaemonQueueCandidate,
  isTaskResumable,
  isTaskRunning,
  isTaskTerminal
} from "../core/tasks/status.ts";
import { getCurrentStep } from "../core/workflows/run.ts";
import {
  findRepoRemediationStepId,
  isPostPushWorkflowStep,
  loadWorkflow,
  stepModifiesRepo,
  taskNeedsGitOperatorFollowup
} from "../core/workflows/index.ts";
import type { HarnessTask } from "../core/types.ts";
import { listInflightTaskIds } from "../runtime/sessions.ts";
import { runTaskTurn } from "./processor.ts";
import { MAX_RESUME_ATTEMPTS, now, type ProcessOptions, type TurnSummary } from "./types.ts";

export function shouldAutoRunAuthorForOperatorFollowup(
  task: HarnessTask,
  workflow: Awaited<ReturnType<typeof loadWorkflow>>
): boolean {
  return taskNeedsGitOperatorFollowup(task, workflow);
}

async function listPersistedRunningTaskIds(root: string): Promise<Set<string>> {
  const runs = await listAllRuns(root);
  return new Set(runs.filter((run) => run.status === "running").map((run) => run.taskId));
}

export async function runOperatorFollowupTurn(
  root: string,
  taskId: string,
  options?: ProcessOptions
): Promise<TurnSummary | null> {
  const task = await getTask(root, taskId);
  if (!task?.workflowRun) return null;

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  if (!shouldAutoRunAuthorForOperatorFollowup(task, workflow)) return null;
  if (isTaskRunning(task, listInflightTaskIds())) return null;

  const remediationStepId = findRepoRemediationStepId(workflow);
  if (!remediationStepId) return null;

  const step = getCurrentStep(workflow, task.workflowRun);
  if (isPostPushWorkflowStep(workflow, step.id)) {
    await routeTaskToImplementationStep(root, taskId);
  }

  return runTaskTurn(root, taskId, options);
}

export async function processNextApprovedTask(
  root: string,
  options?: ProcessOptions
): Promise<TurnSummary | null> {
  const [tasks, runningTaskIds] = await Promise.all([listTasks(root), listPersistedRunningTaskIds(root)]);
  const workflows = await Promise.all(
    tasks.map((t) => (t.workflowRun ? loadWorkflow(root, t.workflowRun.workflowId) : null))
  );
  const next = tasks.find((task, i) => {
    const workflow = workflows[i];
    return workflow && !runningTaskIds.has(task.id) && isDaemonQueueCandidate(task, workflow);
  });
  if (!next) return null;
  return runTaskTurn(root, next.id, options);
}

export async function processAllApprovedTasks(
  root: string,
  options?: ProcessOptions
): Promise<TurnSummary[]> {
  const [tasks, runningTaskIds] = await Promise.all([listTasks(root), listPersistedRunningTaskIds(root)]);
  const workflows = await Promise.all(
    tasks.map((t) => (t.workflowRun ? loadWorkflow(root, t.workflowRun.workflowId) : null))
  );
  const candidates = tasks.filter((task, i) => {
    const workflow = workflows[i];
    return workflow && !runningTaskIds.has(task.id) && isDaemonQueueCandidate(task, workflow);
  });
  const results: TurnSummary[] = [];
  for (const task of candidates) {
    const result = await runTaskTurn(root, task.id, options);
    if (result) results.push(result);
  }
  return results;
}

export async function resumeTask(
  root: string,
  taskId: string,
  options?: ProcessOptions
): Promise<TurnSummary | null> {
  const task = await getTask(root, taskId);
  if (!task) return null;
  if (!isTaskResumable(task)) return null;
  if (isTaskRunning(task, listInflightTaskIds())) return null;
  let workflow: Awaited<ReturnType<typeof loadWorkflow>> | undefined;
  if (task.workflowRun) {
    workflow = await loadWorkflow(root, task.workflowRun.workflowId);
    if (isTaskTerminal(task, workflow)) return null;
  }

  const currentStepId = task.workflowRun?.currentStepId;
  const hasCurrentStepAgentOverride =
    currentStepId !== undefined && task.stageAgentOverrides?.[currentStepId] !== undefined;
  const unscopedLegacyAttempts =
    task.resumeAttemptsStepId == null && (task.resumeAttempts ?? 0) > 0 && !hasCurrentStepAgentOverride;
  const sameStep =
    currentStepId !== undefined &&
    (task.resumeAttemptsStepId === currentStepId || unscopedLegacyAttempts);
  const attempts =
    currentStepId === undefined
      ? (task.resumeAttempts ?? 0) + 1
      : (sameStep ? (task.resumeAttempts ?? 0) : 0) + 1;
  if (attempts > MAX_RESUME_ATTEMPTS) {
    await markTaskBlocked(
      root,
      taskId,
      `Exceeded maximum resume attempts (${MAX_RESUME_ATTEMPTS})`
    );
    return null;
  }
  const attemptUpdates =
    currentStepId !== undefined
      ? { resumeAttempts: attempts, resumeAttemptsStepId: currentStepId }
      : { resumeAttempts: attempts };

  if (workflow && task.workflowRun) {
    const step = getCurrentStep(workflow, task.workflowRun);
    if (step.kind === "agent_turn" && stepModifiesRepo(step)) {
      const workspace = await prepareStepWorkspace(task, step, { harnessRoot: root });
      const gitState = await inspectPostTurnGit(workspace);
      if (gitState && gitState.commitCount > 0 && !gitState.hasUnpushedCommits) {
        await patchTaskExecution(
          root,
          taskId,
          { pausedAt: null, interruptedAt: null, blockedReason: null, completedAt: null },
          {
            ...attemptUpdates,
            pushedAt: now(),
            commitCount: gitState.commitCount,
            checkRound: 0
          },
          { clear: ["currentActivity", "lastCheckFailure", "lastRemediationFingerprint"] }
        );
        await advanceTaskWorkflowStep(root, taskId);
        const updated = (await getTask(root, taskId))!;
        return { runId: updated.runId ?? taskId, execution: "idle" };
      }
    }
  }

  await patchTaskExecution(
    root,
    taskId,
    { pausedAt: null, interruptedAt: null, blockedReason: null, completedAt: null },
    attemptUpdates
  );

  return runTaskTurn(root, taskId, options);
}
