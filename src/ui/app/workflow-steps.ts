import type { HarnessTask, WorkflowSummary } from "./types.js";

export type StepAdvancementMode = "operator" | "daemon" | "neutral";

const DAEMON_STEP_KINDS = new Set(["create_merge_request", "resolve_conflicts", "review", "terminal"]);

export function stepAdvancementMode(workflow: WorkflowSummary, stepId: string): StepAdvancementMode {
  const step = workflow.steps[stepId];
  if (!step) return "neutral";
  if (step.approval === "required") return "operator";
  if (DAEMON_STEP_KINDS.has(step.kind)) return "daemon";
  if (workflow.gitPipeline?.postPushStepIds.includes(stepId)) return "daemon";
  return "neutral";
}

export function isOperatorGatedStep(workflow: WorkflowSummary, stepId: string): boolean {
  return stepAdvancementMode(workflow, stepId) === "operator";
}

export function isDaemonDrivenStep(workflow: WorkflowSummary, stepId: string): boolean {
  return stepAdvancementMode(workflow, stepId) === "daemon";
}

export function stepShowsAutoAdvanceNote(
  task: HarnessTask,
  workflow: WorkflowSummary,
  stepId: string
): boolean {
  const run = task.workflowRun;
  if (!run || run.currentStepId !== stepId) return false;
  if (task.resolution) return false;
  return isDaemonDrivenStep(workflow, stepId);
}

export function currentStepIndex(workflow: WorkflowSummary, currentStepId: string): number {
  const index = workflow.stepIds.indexOf(currentStepId);
  return index >= 0 ? index + 1 : 0;
}