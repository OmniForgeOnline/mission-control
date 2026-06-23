import {
  composeMergeRequestContent,
  createMergeRequestForRepo
} from "../../core/merge-request/index.ts";
import { REPO_BINDING_BLOCKED_REASON } from "../../core/tasks/repo-binding.ts";
import {
  addTaskMessage,
  advanceTaskWorkflowStep,
  markTaskBlocked,
  updateTask
} from "../../core/tasks/tasks.ts";
import { loadWorkflow, type WorkflowStep } from "../../core/workflows/index.ts";
import {
  defaultBaseBranch,
  inspectPostTurnGit,
  type PreparedWorkspace
} from "../../core/worktrees/worktrees.ts";
import type { HarnessTask } from "../../core/types.ts";
import { createRunnerForTool } from "../../runners/index.ts";
import { now, type ProcessOptions, type TurnSummary } from "../types.ts";

export async function executeCreateMergeRequestStep(
  root: string,
  task: HarnessTask,
  workspace: PreparedWorkspace,
  step: WorkflowStep,
  options?: ProcessOptions
): Promise<TurnSummary> {
  const runId = task.runId ?? task.id;

  if (task.mergeRequest) {
    await advanceTaskWorkflowStep(root, task.id);
    return { runId, execution: "idle" };
  }

  if (!workspace.isRepo || !workspace.repoPath) {
    await markTaskBlocked(root, task.id, REPO_BINDING_BLOCKED_REASON, { completedAt: now() });
    return { runId, execution: "blocked" };
  }

  const gitState = await inspectPostTurnGit(workspace);
  const hasPush = Boolean(task.pushedAt) || Boolean(gitState?.pushed);
  if (!hasPush || !workspace.branch) {
    await markTaskBlocked(
      root,
      task.id,
      "Create merge request requires a pushed branch; push did not complete.",
      { completedAt: now() }
    );
    return { runId, execution: "blocked" };
  }

  try {
    const workflow = await loadWorkflow(root, task.workflowRun!.workflowId);
    const authorAgent = workflow.defaults.author;
    const composeRunner =
      options?.runner ?? (await createRunnerForTool(root, authorAgent, "author"));
    const targetBranch = await defaultBaseBranch(workspace.repoPath);
    const composed = await composeMergeRequestContent(
      {
        task,
        repoPath: workspace.repoPath,
        baseBranch: targetBranch,
        sourceBranch: workspace.branch,
        overrides: {
          ...(step.mergeRequestTitle !== undefined ? { title: step.mergeRequestTitle } : {}),
          ...(step.mergeRequestDescription !== undefined ? { description: step.mergeRequestDescription } : {})
        }
      },
      { runner: composeRunner }
    );

    const result = await createMergeRequestForRepo({
      root,
      repoPath: workspace.repoPath,
      sourceBranch: workspace.branch,
      targetBranch,
      title: composed.title,
      description: composed.description
    });

    const mergeRequest = {
      provider: result.provider,
      url: result.url,
      number: result.number
    };

    const label = result.provider === "github" ? "PR" : "MR";
    const action = result.created ? "Created" : "Reused open";
    await addTaskMessage(root, task.id, {
      author: "system",
      body: `${action} ${label} [#${result.number}](${result.url}) for \`${workspace.branch}\`.`,
      stepId: step.id
    });

    await updateTask(root, task.id, (current) => ({
      ...current,
      mergeRequest,
      updatedAt: now()
    }));

    await advanceTaskWorkflowStep(root, task.id);
    return { runId, execution: "idle" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markTaskBlocked(root, task.id, `Merge request creation failed: ${message}`, {
      completedAt: now()
    });
    return { runId, execution: "blocked" };
  }
}
