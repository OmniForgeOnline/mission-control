import { realpath } from "node:fs/promises";
import path from "node:path";

import { safeGit } from "../infra/git.ts";
import type { HarnessTarget, HarnessTask } from "../types.ts";
import {
  collectPostPushStepIds,
  findRepoRemediationStepId,
  isGitWorkflow,
  type WorkflowDefinition
} from "../workflows/index.ts";
import { addTaskMessage, getTask, updateTask } from "./tasks.ts";

export const REPO_BINDING_BLOCKED_REASON =
  "Repository binding required: add a git repository target before opening a merge request.";

export function isRepoBindingBlockedReason(reason: string): boolean {
  return reason.trim().toLowerCase().includes("repository binding required");
}

async function gitTopLevel(dir: string): Promise<string | undefined> {
  const top = await safeGit(dir, ["rev-parse", "--show-toplevel"]);
  return top || undefined;
}

export async function harnessDefaultGitTargets(repoRoot: string): Promise<HarnessTarget[]> {
  const resolved = path.resolve(repoRoot);
  const top = await gitTopLevel(resolved);
  if (!top) return [];
  const canonical = await realpath(top).catch(() => top);
  return [{ raw: `@${canonical}`, path: canonical, kind: "directory" }];
}

export async function resolveTargetsForGitWorkflow(
  harnessRoot: string,
  workflow: WorkflowDefinition,
  extracted: HarnessTarget[]
): Promise<HarnessTarget[]> {
  if (extracted.length > 0) return extracted;
  if (!isGitWorkflow(workflow)) return extracted;
  return harnessDefaultGitTargets(harnessRoot);
}

export function taskNeedsRepoBinding(task: HarnessTask, workflow: WorkflowDefinition): boolean {
  if (!isGitWorkflow(workflow)) return false;
  if (task.targets.length > 0) return false;
  if (isRepoBindingBlockedReason(task.blockedReason ?? "")) return true;
  if (!task.workflowRun) return false;

  const stepId = task.workflowRun.currentStepId;
  const remediation = findRepoRemediationStepId(workflow);
  if (remediation && stepId === remediation) return true;
  return collectPostPushStepIds(workflow).has(stepId);
}

export async function bindTaskRepoTarget(
  root: string,
  taskId: string,
  rawPath: string
): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error("Repository path is required.");
  }

  const resolved = path.resolve(trimmed.startsWith("@") ? trimmed.slice(1) : trimmed);
  const repoPath = await gitTopLevel(resolved);
  if (!repoPath) {
    throw new Error(`Not a git repository: ${resolved}`);
  }
  const canonical = await realpath(repoPath).catch(() => repoPath);

  const target: HarnessTarget = {
    raw: trimmed.startsWith("@") ? trimmed : `@${canonical}`,
    path: canonical,
    kind: "directory"
  };

  const bound = await updateTask(root, taskId, (current) => {
    const {
      repoPath: _repoPath,
      branch: _branch,
      workspacePath: _workspacePath,
      pushedAt: _pushedAt,
      mergeRequest: _mergeRequest,
      worktreeCleanedAt: _worktreeCleanedAt,
      blockedReason,
      ...rest
    } = current;
    return {
      ...rest,
      targets: [target],
      ...(isRepoBindingBlockedReason(blockedReason ?? "") ? {} : blockedReason ? { blockedReason } : {})
    };
  });

  await addTaskMessage(root, taskId, {
    author: "system",
    body: `Repository bound to \`${repoPath}\`. Resume the task to continue the git workflow.`
  });

  return (await getTask(root, taskId)) ?? bound;
}