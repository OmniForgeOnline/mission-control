import type { ToolId, EffortLevel } from "../types.ts";
import type { StageAgentOverrides } from "../agents/stage-agents.ts";
import {
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowStepAgent
} from "./types.ts";

export function orderedStepIds(workflow: WorkflowDefinition): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = workflow.initial;
  while (current && !seen.has(current)) {
    seen.add(current);
    ordered.push(current);
    const step: WorkflowStep | undefined = workflow.steps[current];
    if (!step) break;
    if (step.parallel?.length) {
      for (const parallelId of step.parallel) {
        if (!seen.has(parallelId)) {
          seen.add(parallelId);
          ordered.push(parallelId);
        }
      }
      const joinTarget = step.parallel.map((id) => workflow.steps[id]?.join).find(Boolean);
      current = joinTarget;
    } else {
      current = step.next;
    }
  }
  for (const id of Object.keys(workflow.steps)) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

export function getStep(workflow: WorkflowDefinition, stepId: string): WorkflowStep {
  const step = workflow.steps[stepId];
  if (!step) {
    throw new Error(`Unknown workflow step: ${stepId}`);
  }
  return step;
}

export function findUpstreamStepId(
  workflow: Pick<WorkflowDefinition, "steps">,
  targetStepId: string
): string | null {
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (step.next === targetStepId) return stepId;
    if (step.parallel?.includes(targetStepId)) return stepId;
    if (step.branch) {
      for (const next of Object.values(step.branch)) {
        if (next === targetStepId) return stepId;
      }
    }
  }
  return null;
}

export function findImplementationStepId(workflow: Pick<WorkflowDefinition, "steps">): string | null {
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (step.skill === "pr-driven-execution") return stepId;
  }
  return workflow.steps["implement"] ? "implement" : null;
}

export function findMergeRequestStepId(workflow: Pick<WorkflowDefinition, "steps">): string | null {
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    if (step.kind === "create_merge_request") return stepId;
  }
  return null;
}

export function stepModifiesRepo(step: WorkflowStep): boolean {
  if (step.modifiesRepo === true) return true;
  if (step.modifiesRepo === false) return false;
  if (step.skill === "pr-driven-execution") return true;
  if (
    step.kind === "create_merge_request" ||
    step.kind === "resolve_conflicts" ||
    step.kind === "review"
  ) {
    return true;
  }
  return false;
}

export function stepUsesRepoWorkspace(step: WorkflowStep, task: { repoPath?: string; workspacePath?: string }): boolean {
  if (stepModifiesRepo(step)) return true;
  if (
    (step.kind === "create_merge_request" ||
      step.kind === "resolve_conflicts" ||
      step.kind === "review") &&
    task.repoPath
  ) {
    return true;
  }
  if (step.kind === "agent_turn" && task.workspacePath && task.repoPath) return true;
  return false;
}

export function assertValidWorkflowStep(workflow: WorkflowDefinition, stepId: string): void {
  getStep(workflow, stepId);
}

export function isWorkflowAgentTool(agent: WorkflowStepAgent): agent is ToolId {
  return agent !== "none" && agent !== "author" && agent !== "reviewer";
}

export function resolveStepAgent(
  workflow: WorkflowDefinition,
  overrides: StageAgentOverrides,
  stepId: string,
  defaultAgent: ToolId,
  taskOverrides?: Partial<Record<string, ToolId>>
): ToolId | null {
  const step = workflow.steps[stepId];
  if (!step || step.agent === "none") return null;

  const taskOverride = taskOverrides?.[stepId];
  if (taskOverride) return taskOverride;

  const override = overrides.overrides[stepId];
  if (override) return override;

  if (isWorkflowAgentTool(step.agent)) {
    return step.agent;
  }

  if (step.agent === "author") {
    return workflow.defaults.author;
  }
  if (step.agent === "reviewer") {
    return workflow.defaults.reviewer;
  }

  return defaultAgent;
}

/**
 * Whether a workflow step can take an effort level. Effort only applies to steps
 * that run an agent turn — not to checks, merge-request, or terminal steps, and
 * not to steps with no agent.
 */
export function stepSupportsEffort(workflow: WorkflowDefinition, stepId: string): boolean {
  const step = workflow.steps[stepId];
  return Boolean(
    step &&
      step.agent !== "none" &&
      step.kind !== "create_merge_request" &&
      step.kind !== "terminal"
  );
}

export function resolveStepEffort(workflow: WorkflowDefinition, stepId: string): EffortLevel | undefined {
  if (!stepSupportsEffort(workflow, stepId)) {
    return undefined;
  }
  return workflow.steps[stepId]!.effort ?? workflow.defaults.effort;
}

/**
 * Effort to pass to the runner for a step, in precedence order:
 * per-step override → task-level effort → step/workflow default.
 */
export function effortForRunner(
  workflow: WorkflowDefinition,
  stepId: string,
  overrides: { stageOverride?: EffortLevel | undefined; taskEffort?: EffortLevel | undefined }
): EffortLevel | undefined {
  return overrides.stageOverride ?? overrides.taskEffort ?? resolveStepEffort(workflow, stepId);
}