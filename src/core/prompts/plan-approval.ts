import { extractFinalPlan } from "../workflows/prompts.ts";
/** Minimal task shape for browser-safe plan approval checks. */
export interface PlanApprovalTask {
  description?: string;
  messages?: Array<{ author: string; body: string }>;
  workflowRun?: {
    currentStepId: string;
    stepApprovals?: Record<string, { status: string }>;
  };
}

/** Minimal workflow shape for plan-approval checks (browser-safe; no filesystem deps). */
export interface WorkflowPlanApprovalLookup {
  steps: Record<string, { kind: string; agent?: string; skill?: string; next?: string; approval?: string }>;
}

function findImplementationStepId(workflow: WorkflowPlanApprovalLookup): string | null {
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (step.skill === "pr-driven-execution") return stepId;
  }
  return workflow.steps["implement"] ? "implement" : null;
}

/** Extract plan text from description or the latest agent message. */
export function extractPlanFromTask(task: PlanApprovalTask): string | undefined {
  if (task.description?.includes("## Plan")) {
    const section = task.description.split("## Plan").slice(1).join("## Plan").trim();
    if (section) return section;
  }
  const lastAgent = (task.messages ?? []).filter((m) => m.author === "agent").at(-1);
  if (!lastAgent) return undefined;
  return extractFinalPlan(lastAgent.body);
}

function hasPlanReady(task: PlanApprovalTask): boolean {
  return Boolean(extractPlanFromTask(task));
}

function isPlanGateStep(step: WorkflowPlanApprovalLookup["steps"][string] | undefined): boolean {
  return step?.kind === "agent_turn" && step.agent === "none" && step.approval === "required";
}

/** True when the task has a plan ready and the operator can skip to implementation. */
export function canApprovePlan(task: PlanApprovalTask, workflow: WorkflowPlanApprovalLookup): boolean {
  const run = task.workflowRun;
  if (!run) return false;

  const implementationStepId = findImplementationStepId(workflow);
  if (!implementationStepId) return false;
  if (!hasPlanReady(task)) return false;

  const agentTurns = (task.messages ?? []).filter((m) => m.author === "agent").length;
  if (agentTurns === 0) return false;

  const step = workflow.steps[run.currentStepId];
  if (!step) return false;

  if (agentTurns > 0 && step.kind === "conversation") {
    return true;
  }

  const approved = run.stepApprovals?.[run.currentStepId]?.status === "approved";
  const needsApproval = step.approval === "required" && !approved;

  // Queued at plan_gate or legacy proposal-first approval step.
  if (needsApproval && step.kind === "agent_turn") {
    if (isPlanGateStep(step) && step.next === implementationStepId) return true;
    if (step.skill === "proposal-first" && step.next === implementationStepId) return true;
  }

  return false;
}