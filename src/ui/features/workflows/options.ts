import type { EffortLevel } from "../../../core/types.ts";
import type { WorkflowStep, WorkflowStepApproval, WorkflowStepKind } from "../../../core/workflows/types.ts";

/**
 * A partial step update where a value of `undefined` means "clear this field".
 * Required because the project enables exactOptionalPropertyTypes, so plain
 * Partial<WorkflowStep> rejects `{ effort: undefined }`.
 */
export type StepPatch = { [K in keyof WorkflowStep]?: WorkflowStep[K] | undefined };

export const WORKFLOW_KINDS: readonly WorkflowStepKind[] = [
  "conversation",
  "agent_turn",
  "create_merge_request",
  "resolve_conflicts",
  "review",
  "terminal"
];

export const APPROVAL_OPTIONS: readonly WorkflowStepApproval[] = ["required", "none"];

export const EFFORT_OPTIONS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Roles a step may reference (resolved via workflow defaults) plus the no-agent marker. */
export const STEP_AGENT_ROLES: readonly string[] = ["none", "author", "reviewer"];

export interface AgentOption {
  id: string;
  displayName: string;
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "agent_turn":
      return "Agent turn";
    case "create_merge_request":
      return "Merge request";
    case "resolve_conflicts":
      return "Resolve conflicts";
    default:
      return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}
