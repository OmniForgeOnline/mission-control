import type { WorkflowStepKind } from "./index.ts";

/**
 * Fully programmatic: harness runs the step with no agent turn.
 * Outcome is deterministic (open MR, mark complete, auto-advance gate).
 */
export const MECHANICAL_STEP_KINDS = ["create_merge_request", "terminal"] as const satisfies readonly WorkflowStepKind[];

/**
 * Hybrid: harness runs project-specific automation; agents handle failures or judgment.
 * Mechanical checks are no longer a workflow stage: the post-implementation turn runs
 * the project-aware planner (see `core/review/checks.ts`) inline, so the author agent
 * is gated exactly once.
 * - resolve_conflicts: harness merges the latest base branch; author agent resolves
 *           any true conflicts before the PR/MR proceeds to review.
 * - review: harness gathers worktree context; reviewer agent judges.
 */
export const HYBRID_STEP_KINDS = ["resolve_conflicts", "review"] as const satisfies readonly WorkflowStepKind[];

/** Agent judgment turns where harness attaches workspace artifacts before the prompt. */
const WORKSPACE_ARTIFACT_SKILLS = ["seo-growth", "frontend-qa", "content-production"] as const;

export type MechanicalStepKind = (typeof MECHANICAL_STEP_KINDS)[number];
export type HybridStepKind = (typeof HYBRID_STEP_KINDS)[number];

export function isMechanicalStepKind(kind: WorkflowStepKind): kind is MechanicalStepKind {
  return (MECHANICAL_STEP_KINDS as readonly string[]).includes(kind);
}

export function isHybridStepKind(kind: WorkflowStepKind): kind is HybridStepKind {
  return (HYBRID_STEP_KINDS as readonly string[]).includes(kind);
}

export function shouldAttachWorkspaceArtifacts(skill: string | undefined): boolean {
  if (!skill) return false;
  return (WORKSPACE_ARTIFACT_SKILLS as readonly string[]).includes(skill);
}