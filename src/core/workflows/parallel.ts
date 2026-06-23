import type { WorkflowRun } from "../types.ts";
import { getStep, type WorkflowDefinition } from "./index.ts";

/** Steps that must complete before a join step can fire. */
export function collectJoinPredecessors(
  workflow: Pick<WorkflowDefinition, "steps">,
  joinStepId: string
): string[] {
  const predecessors: string[] = [];
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (step.join === joinStepId) predecessors.push(stepId);
  }
  return predecessors;
}

export function joinPolicyForStep(
  workflow: Pick<WorkflowDefinition, "steps">,
  joinStepId: string
): "all" | "any" {
  return workflow.steps[joinStepId]?.joinPolicy ?? "all";
}

export function isJoinReady(
  workflow: Pick<WorkflowDefinition, "steps">,
  run: Pick<WorkflowRun, "completedSteps">,
  joinStepId: string
): boolean {
  const predecessors = collectJoinPredecessors(workflow, joinStepId);
  if (predecessors.length === 0) return false;

  const completed = new Set(run.completedSteps);
  const policy = joinPolicyForStep(workflow, joinStepId);
  if (policy === "any") {
    return predecessors.some((id) => completed.has(id));
  }
  return predecessors.every((id) => completed.has(id));
}

/** Persist the live frontier; single-token runs keep legacy currentStepId-only storage. */
export function setWorkflowFrontier(run: WorkflowRun, activeStepIds: string[]): WorkflowRun {
  if (activeStepIds.length === 0) {
    return { ...run, activeStepIds: [] };
  }
  if (activeStepIds.length === 1) {
    const [only] = activeStepIds;
    if (!only) return { ...run, activeStepIds: [] };
    const { activeStepIds: _frontier, ...rest } = run;
    return {
      ...rest,
      currentStepId: only
    };
  }
  const [head] = activeStepIds;
  return {
    ...run,
    currentStepId: head ?? run.currentStepId,
    activeStepIds: [...activeStepIds]
  };
}

function tryFireJoin(
  workflow: WorkflowDefinition,
  run: WorkflowRun,
  joinStepId: string
): string[] {
  return isJoinReady(workflow, run, joinStepId) ? [joinStepId] : [];
}

function dedupeStepIds(stepIds: string[]): string[] {
  const seen = new Set<string>();
  return stepIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function resolveTokenSuccessors(
  workflow: WorkflowDefinition,
  run: WorkflowRun,
  completedStepId: string,
  branch?: string
): string[] {
  const step = getStep(workflow, completedStepId);

  if (branch && step.branch?.[branch]) {
    return [step.branch[branch]!];
  }

  if (branch === "passed" && step.join) {
    return tryFireJoin(workflow, run, step.join);
  }

  if (step.parallel?.length) {
    return [...step.parallel];
  }

  if (step.next) {
    return [step.next];
  }

  if (step.join) {
    return tryFireJoin(workflow, run, step.join);
  }

  return [];
}

export function isBranchOnlyStep(step: { next?: string; parallel?: string[]; join?: string; branch?: Record<string, string> }): boolean {
  return Boolean(step.branch && !step.next && !step.parallel?.length && !step.join);
}

export function advanceCompletedToken(
  workflow: WorkflowDefinition,
  run: WorkflowRun,
  completedStepId: string,
  branch?: string
): WorkflowRun {
  const step = getStep(workflow, completedStepId);
  const active = run.activeStepIds !== undefined ? [...run.activeStepIds] : [run.currentStepId];
  const isRemediationBranch = Boolean(branch && branch !== "passed" && step.branch?.[branch]);

  const remainingActive = isRemediationBranch ? [] : active.filter((id) => id !== completedStepId);
  const completedSteps = run.completedSteps.includes(completedStepId)
    ? run.completedSteps
    : [...run.completedSteps, completedStepId];
  const runAfterComplete = { ...run, completedSteps };

  const successors = resolveTokenSuccessors(workflow, runAfterComplete, completedStepId, branch);
  if (successors.length === 0 && remainingActive.length === 0 && isBranchOnlyStep(step) && !branch) {
    return runAfterComplete;
  }

  const nextActive = dedupeStepIds(isRemediationBranch ? successors : [...remainingActive, ...successors]);
  return setWorkflowFrontier(runAfterComplete, nextActive);
}