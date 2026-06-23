import {
  abortMerge,
  attemptBaseMerge,
  buildConflictRemediationPrompt,
  describeBaseMergeOutcome,
  pushCurrentBranch
} from "../../core/review/merge-conflicts.ts";
import {
  addTaskMessage,
  advanceTaskWorkflowStep,
  markTaskBlocked,
  markTaskRunning,
  updateTask
} from "../../core/tasks/tasks.ts";
import { deriveExecution } from "../../core/tasks/status.ts";
import {
  findImplementationStepId,
  findRepoRemediationStepId,
  type WorkflowDefinition,
  type WorkflowStep
} from "../../core/workflows/index.ts";
import type { HarnessTask } from "../../core/types.ts";
import type { PreparedWorkspace } from "../../core/worktrees/worktrees.ts";
import { scheduleAuthorRerun } from "../agent-turn.ts";
import {
  fingerprintRemediationError,
  REMEDIATION_STAGNATION_LIMIT,
  shouldStopRemediation
} from "../remediation.ts";
import { now, type ProcessOptions, type TurnSummary } from "../types.ts";

const PUSH_ERROR_MAX = 500;

/**
 * Merge the latest base branch into the task branch so the PR/MR stays mergeable.
 * Clean merges are pushed and the workflow advances; true conflicts route back to
 * the author step with a resolution prompt (capped like mechanical-check remediation).
 */
export async function executeResolveConflictsStep(
  root: string,
  task: HarnessTask,
  workspace: PreparedWorkspace,
  workflow: WorkflowDefinition,
  step: WorkflowStep,
  options?: ProcessOptions
): Promise<TurnSummary> {
  const runId = task.runId ?? task.id;

  if (!workspace.isRepo || !workspace.repoPath) {
    const advanced = await advanceTaskWorkflowStep(root, task.id);
    return { runId, execution: deriveExecution(advanced) };
  }

  const result = await attemptBaseMerge(workspace.cwd, workspace.repoPath);

  await addTaskMessage(root, task.id, {
    author: "system",
    body: describeBaseMergeOutcome(result),
    stepId: step.id
  });

  if (result.status === "merged_clean" && workspace.branch) {
    const push = await pushCurrentBranch(workspace.cwd, workspace.branch);
    if (push.exitCode !== 0) {
      await markTaskBlocked(
        root,
        task.id,
        `Merged \`${result.baseBranch}\` into the branch but pushing the merge failed: ${push.output
          .trim()
          .slice(0, PUSH_ERROR_MAX)}`,
        { completedAt: now() }
      );
      return { runId, execution: "blocked" };
    }
    await updateTask(root, task.id, (current) => ({ ...current, pushedAt: now(), updatedAt: now() }));
  }

  if (result.status !== "conflicted") {
    const advanced = await advanceTaskWorkflowStep(root, task.id);
    return { runId, execution: deriveExecution(advanced) };
  }

  const round = (task.conflictRound ?? 0) + 1;
  const remediationStepId = findImplementationStepId(workflow) ?? findRepoRemediationStepId(workflow);
  const fingerprint = fingerprintRemediationError(result.conflictedFiles.join("\n"));
  const streak =
    task.lastRemediationFingerprint === fingerprint ? (task.remediationStreak ?? 0) + 1 : 1;

  if (!remediationStepId || shouldStopRemediation(round, streak)) {
    await abortMerge(workspace.cwd);
    await markTaskBlocked(
      root,
      task.id,
      streak >= REMEDIATION_STAGNATION_LIMIT
        ? `Merge conflict resolution blocked: same conflict repeated ${streak} times`
        : `Merge conflict resolution blocked after ${round} attempts`,
      { completedAt: now() }
    );
    return { runId, execution: "blocked" };
  }

  await updateTask(root, task.id, (current) => ({
    ...current,
    conflictRound: round,
    remediationStreak: streak,
    lastRemediationFingerprint: fingerprint,
    updatedAt: now()
  }));

  await advanceTaskWorkflowStep(root, task.id, "conflicts", step.id);

  await addTaskMessage(root, task.id, {
    author: "system",
    body: `Merge conflicts detected. Re-running \`${remediationStepId}\` to resolve them.`,
    stepId: step.id
  });
  await markTaskRunning(root, task.id, {});
  return scheduleAuthorRerun(
    root,
    task.id,
    buildConflictRemediationPrompt(result, round),
    options,
    remediationStepId
  );
}
