import { parseReviewerVerdict } from "../review/code-review.ts";
import { runChecks } from "../review/checks.ts";
import type { WorkflowDefinition } from "../workflows/types.ts";
import type { DeterministicCheckKind } from "./types.ts";

/** Whether a workflow definition includes the given step id. */
export function workflowHasStep(workflow: WorkflowDefinition, stepId: string): boolean {
  return Object.prototype.hasOwnProperty.call(workflow.steps, stepId);
}

/** Whether any path matches a simple glob-style pattern (`**` and `*` only). */
export function artifactPathMatches(pattern: string, paths: readonly string[]): boolean {
  const regex = new RegExp(
    `^${pattern
      .split("/")
      .map((segment) =>
        segment === "**"
          ? ".*"
          : segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")
      )
      .join("/")}$`
  );
  return paths.some((entry) => regex.test(entry));
}

export const EVAL_CHECK_KIND_HELPERS = {
  "reviewer-verdict": parseReviewerVerdict,
  "checks-outcome": runChecks,
  "workflow-step": workflowHasStep,
  "artifact-present": artifactPathMatches
} as const satisfies Record<DeterministicCheckKind, unknown>;

export const REGISTERED_EVAL_CHECK_KINDS = new Set<DeterministicCheckKind>(
  Object.keys(EVAL_CHECK_KIND_HELPERS) as DeterministicCheckKind[]
);

export function isRegisteredEvalCheckKind(kind: string): kind is DeterministicCheckKind {
  return REGISTERED_EVAL_CHECK_KINDS.has(kind as DeterministicCheckKind);
}
