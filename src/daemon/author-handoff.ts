import type { HarnessTask } from "../core/types.ts";
import { addTaskMessage, markTaskBlocked, markTaskRunning, updateTask } from "../core/tasks/tasks.ts";
import { deriveExecution } from "../core/tasks/status.ts";
import type { PostTurnGitState } from "../core/worktrees/worktrees.ts";
import { markMergeRequestReadyForRepo } from "../core/merge-request/index.ts";
import { scheduleAuthorRerun } from "./agent-turn.ts";
import { now, type RunTurnInternal, type TurnSummary } from "./types.ts";

const MAX_AUTHOR_HANDOFF_ROUNDS = 3;

function turnResult(runId: string, task: HarnessTask): TurnSummary {
  return { runId, execution: deriveExecution(task) };
}

/**
 * Remove the draft flag from the task's merge request at the final handoff,
 * after review has accepted the work. This is the ONLY point at which an MR/PR
 * becomes ready; creation always opens it as a draft, and a review that returns
 * the ticket to implementation never reaches here.
 *
 * Best-effort: a forge API failure must not block task completion, so errors are
 * surfaced as a system message (the operator can mark the MR ready manually)
 * rather than thrown. Silent on success because readiness is the expected state
 * at handoff and operators watch the forge UI, not the message log, for it.
 */
export async function markMergeRequestReadyAtHandoff(
  root: string,
  task: HarnessTask,
  repoPath: string | undefined,
  stepId: string
): Promise<void> {
  const mergeRequest = task.mergeRequest;
  if (!mergeRequest || !repoPath) return;

  try {
    await markMergeRequestReadyForRepo({
      root,
      repoPath,
      provider: mergeRequest.provider,
      number: mergeRequest.number
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addTaskMessage(root, task.id, {
      author: "system",
      body: `Could not mark the merge request ready for review at handoff; it may still be a draft. Mark it ready manually in the forge.\n\n${message}`,
      stepId
    });
  }
}

export function describeAuthorGitHandoffFailure(
  workspaceBranch: string | undefined,
  gitState: PostTurnGitState | null
): string | null {
  if (!gitState) return null;
  const problems: string[] = [];
  if (!workspaceBranch) {
    problems.push("No task branch is available for this repo-scoped workflow.");
  }
  if (gitState.hasUncommittedChanges) {
    problems.push(`Uncommitted changes remain:\n${gitState.status}`);
  }
  if (gitState.commitCount <= 0) {
    problems.push("No author commit exists ahead of the base branch.");
  }
  if (!gitState.pushed) {
    problems.push(
      gitState.hasUnpushedCommits
        ? "The local branch has commits that have not been pushed."
        : "The remote task branch does not contain the local HEAD."
    );
  }
  if (!problems.length) return null;
  return [
    "Author handoff did not satisfy the repo contract.",
    "",
    ...problems,
    "",
    "Expected contract: run the appropriate checks, stage only intended files, commit, push the task branch, then report the pushed branch and verification. Do not create the PR/MR directly; Mission Control will do that after a valid push."
  ].join("\n");
}

export async function rerunAuthorForGitHandoffFailure(
  root: string,
  task: HarnessTask,
  failure: string,
  options: RunTurnInternal["options"],
  stepId: string,
  baseUpdates: Partial<HarnessTask>,
  completedAt: string
): Promise<TurnSummary> {
  const round = (task.checkRound ?? 0) + 1;
  if (round > MAX_AUTHOR_HANDOFF_ROUNDS) {
    const blocked = await markTaskBlocked(
      root,
      task.id,
      `Author handoff failed after ${MAX_AUTHOR_HANDOFF_ROUNDS} attempts:\n\n${failure}`,
      {
        ...baseUpdates,
        completedAt,
        checkRound: round,
        lastCheckFailure: failure
      }
    );
    return turnResult(task.runId ?? task.id, blocked);
  }

  await updateTask(root, task.id, (current) => ({
    ...current,
    ...baseUpdates,
    checkRound: round,
    lastCheckFailure: failure,
    updatedAt: now()
  }));
  await addTaskMessage(root, task.id, {
    author: "system",
    body: `${failure}\n\nRe-running the author so commit/push failures stay inside the agent loop.`,
    stepId
  });
  await markTaskRunning(root, task.id, baseUpdates);
  return scheduleAuthorRerun(
    root,
    task.id,
    `${failure}\n\nFix the repository handoff now. You must leave the worktree clean, commit the intended changes, and push the task branch before your final answer.`,
    options,
    stepId
  );
}
