import type { WorkflowRun } from "../types.ts";
import {
  extractPlanFromTask,
  type PlanApprovalTask,
  type WorkflowPlanApprovalLookup
} from "./plan-approval.ts";

export type { PlanApprovalTask, WorkflowPlanApprovalLookup };

function findImplementationStepId(workflow: WorkflowPlanApprovalLookup): string | null {
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (step.skill === "pr-driven-execution") return stepId;
  }
  return workflow.steps["implement"] ? "implement" : null;
}

function hasPlanReady(task: PlanApprovalTask): boolean {
  return Boolean(extractPlanFromTask(task));
}

function isPlanGateStep(step: WorkflowPlanApprovalLookup["steps"][string] | undefined): boolean {
  return step?.kind === "agent_turn" && step.agent === "none" && step.approval === "required";
}

function implementationNotStarted(task: PlanRefinementTask): boolean {
  return !task.branch && !task.pushedAt && !task.mergeRequest;
}

function findUpstreamStepId(
  workflow: WorkflowPlanApprovalLookup,
  targetStepId: string
): string | null {
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (step.next === targetStepId) return stepId;
  }
  return null;
}

function jumpToWorkflowStep(run: WorkflowRun, stepId: string): WorkflowRun {
  return { ...run, currentStepId: stepId };
}

/** Extended task shape for plan-refinement checks (includes repo progress signals). */
export interface PlanRefinementTask extends PlanApprovalTask {
  approvedAt?: string;
  branch?: string;
  pushedAt?: string;
  mergeRequest?: { number: number };
}

/** Walk upstream from the current step until a conversation step is found. */
export function findPlanningConversationStepId(
  workflow: WorkflowPlanApprovalLookup,
  run: WorkflowRun
): string | null {
  let stepId: string | null = run.currentStepId;
  const seen = new Set<string>();

  while (stepId && !seen.has(stepId)) {
    seen.add(stepId);
    const step = workflow.steps[stepId];
    if (!step) return null;
    if (step.kind === "conversation") return stepId;
    stepId = findUpstreamStepId(workflow, stepId);
  }

  return null;
}

/** True when the operator can send feedback that should trigger a planning turn. */
export function canRefinePlan(task: PlanRefinementTask, workflow: WorkflowPlanApprovalLookup): boolean {
  const run = task.workflowRun;
  if (!run) return false;
  if (!hasPlanReady(task)) return false;

  const agentTurns = (task.messages ?? []).filter((m) => m.author === "agent").length;
  if (agentTurns === 0) return false;

  const step = workflow.steps[run.currentStepId];
  if (!step) return false;

  if (agentTurns > 0 && step.kind === "conversation") {
    return true;
  }

  const implementationStepId = findImplementationStepId(workflow);
  const approved = run.stepApprovals?.[run.currentStepId]?.status === "approved";
  const needsApproval = step.approval === "required" && !approved;

  if (isPlanGateStep(step) && needsApproval && step.next === implementationStepId) {
    return true;
  }

  if (
    implementationStepId &&
    run.currentStepId === implementationStepId &&
    implementationNotStarted(task)
  ) {
    return true;
  }

  return false;
}

/** Move the workflow pointer back to the planning conversation step for refinement. */
export function rewindWorkflowForPlanRefinement(
  workflow: WorkflowPlanApprovalLookup,
  run: WorkflowRun
): WorkflowRun | null {
  const planningStepId = findPlanningConversationStepId(workflow, run);
  if (!planningStepId) return null;

  const stepsToClear = new Set<string>();
  let stepId: string | null = run.currentStepId;
  const seen = new Set<string>();

  while (stepId && stepId !== planningStepId && !seen.has(stepId)) {
    seen.add(stepId);
    stepsToClear.add(stepId);
    stepId = findUpstreamStepId(workflow, stepId);
  }

  const completedSteps = run.completedSteps.filter(
    (id) => !stepsToClear.has(id) && id !== planningStepId
  );
  const stepApprovals = { ...run.stepApprovals };
  for (const id of stepsToClear) {
    delete stepApprovals[id];
  }

  return jumpToWorkflowStep(
    { ...run, completedSteps, stepApprovals },
    planningStepId
  );
}

const STAGE_LABELS: Record<string, string> = {
  plan: "Planning",
  plan_gate: "Plan review",
  investigate: "Investigation",
  implement: "Implementation",
  fix: "Fix",
  checks: "Checks",
  create_merge_request: "Create merge request",
  review: "Review",
  handoff: "Handoff"
};

/** Human-readable workflow stage label for UI display. */
export function workflowStageLabel(stepId: string): string {
  return STAGE_LABELS[stepId] ?? stepId.replace(/_/g, " ");
}

/** True when queued on the implementation step before any repo work has started. */
export function isPreImplementationReview(
  task: PlanRefinementTask,
  workflow: WorkflowPlanApprovalLookup
): boolean {
  const run = task.workflowRun;
  if (!run || task.approvedAt) return false;
  const implementationStepId = findImplementationStepId(workflow);
  return Boolean(
    implementationStepId &&
      run.currentStepId === implementationStepId &&
      canRefinePlan(task, workflow)
  );
}