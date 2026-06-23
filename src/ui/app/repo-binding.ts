import type { HarnessTask, WorkflowSummary } from "./types.js";

export function isRepoBindingBlockedReason(reason: string): boolean {
  return reason.trim().toLowerCase().includes("repository binding required");
}

export function taskNeedsRepoBinding(task: HarnessTask, workflow: WorkflowSummary): boolean {
  const pipeline = workflow.gitPipeline;
  if (!pipeline) return false;
  if (task.targets.length > 0) return false;
  if (isRepoBindingBlockedReason(task.blockedReason ?? "")) return true;
  if (!task.workflowRun) return false;

  const stepId = task.workflowRun.currentStepId;
  if (stepId === pipeline.remediationStepId) return true;
  return pipeline.postPushStepIds.includes(stepId);
}