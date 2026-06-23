import { isAwaitingOperator, isAwaitingReview } from "../tasks/status.ts";
import type { HarnessTask } from "../types.ts";
import type { WorkflowDefinition } from "./types.ts";

/** Workflows that branch, commit, push, and open PRs/MRs. */
export const GIT_WORKFLOW_IDS = [
  "code-feature",
  "bugfix",
  "technical-debt",
  "infrastructure-change",
  "frontend-ui-change"
] as const;

export type GitWorkflowId = (typeof GIT_WORKFLOW_IDS)[number];

export function isGitWorkflow(workflow: Pick<WorkflowDefinition, "id" | "steps">): boolean {
  if ((GIT_WORKFLOW_IDS as readonly string[]).includes(workflow.id)) return true;
  return Object.values(workflow.steps).some((step) => step.kind === "create_merge_request");
}

/** Author step that owns branch/commit/push (`pr-driven-execution`), with review-branch fallback. */
export function findRepoRemediationStepId(workflow: Pick<WorkflowDefinition, "steps">): string | null {
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (step.skill === "pr-driven-execution") return stepId;
  }
  if (workflow.steps["implement"]) return "implement";

  for (const step of Object.values(workflow.steps)) {
    if (step.kind === "review" && step.branch?.["changes_requested"]) {
      return step.branch["changes_requested"];
    }
  }
  return null;
}

/** Steps at or after the repo author step (checks, MR, review, handoff, …). */
export function collectPostPushStepIds(workflow: Pick<WorkflowDefinition, "steps">): Set<string> {
  const remediationStepId = findRepoRemediationStepId(workflow);
  if (!remediationStepId) return new Set();

  const reached = new Set<string>();
  const queue = [remediationStepId];
  while (queue.length) {
    const stepId = queue.shift()!;
    if (reached.has(stepId)) continue;
    reached.add(stepId);
    const step = workflow.steps[stepId];
    if (!step) continue;
    if (step.next) queue.push(step.next);
    if (step.parallel) queue.push(...step.parallel);
    if (step.join) queue.push(step.join);
    if (step.branch) queue.push(...Object.values(step.branch));
  }
  return reached;
}

export function isPostPushWorkflowStep(
  workflow: Pick<WorkflowDefinition, "steps">,
  stepId: string
): boolean {
  return collectPostPushStepIds(workflow).has(stepId);
}

export function taskNeedsGitOperatorFollowup(
  task: Pick<
    HarnessTask,
    "workflowRun" | "pushedAt" | "mergeRequest" | "resolution" | "blockedReason" | "pausedAt" | "interruptedAt" | "messages" | "turnCount" | "reviewState"
  >,
  workflow: WorkflowDefinition
): boolean {
  if (!task.workflowRun) return false;
  if (isAwaitingOperator(task as HarnessTask, workflow)) return true;
  if (!isGitWorkflow(workflow)) return false;
  if (!task.pushedAt && !task.mergeRequest) return false;

  const eligible =
    task.resolution === "completed" ||
    Boolean(task.blockedReason) ||
    isAwaitingReview(task as HarnessTask, workflow) ||
    (!task.resolution && !task.blockedReason && !task.pausedAt && !task.interruptedAt);
  if (!eligible) return false;

  const step = workflow.steps[task.workflowRun.currentStepId];
  if (!step || step.kind === "conversation") return false;

  return isPostPushWorkflowStep(workflow, task.workflowRun.currentStepId);
}