import type { ResolvedRouting } from "../agents/stage-agents.ts";
import type { StageModelPoolOverrides } from "../agents/stage-model-pools.ts";
import { lookupStageModelPoolOverride } from "../agents/stage-model-pools.ts";
import type { ModelPoolId } from "../types.ts";

export interface ReviewerIndependenceInput {
  required: boolean;
  author: ResolvedRouting;
  reviewer: ResolvedRouting;
  authorStepId: string;
  reviewerStepId: string;
  workflowId: string;
  taskModelPoolOverrides?: Partial<Record<string, ModelPoolId>>;
  workflowModelPoolOverrides?: StageModelPoolOverrides;
}

function hasPinnedModelPool(
  stepId: string,
  workflowId: string,
  taskModelPoolOverrides: Partial<Record<string, ModelPoolId>> | undefined,
  workflowModelPoolOverrides: StageModelPoolOverrides | undefined
): boolean {
  if (taskModelPoolOverrides?.[stepId]) return true;
  return Boolean(
    lookupStageModelPoolOverride(workflowModelPoolOverrides ?? { overrides: {} }, workflowId, stepId)
  );
}

/** Returns a block reason when reviewer independence cannot be satisfied. */
export function reviewerIndependenceViolation(input: ReviewerIndependenceInput): string | null {
  if (!input.required) return null;

  if (input.author.toolId === input.reviewer.toolId) {
    return (
      `Reviewer independence requires a different agent than the author ` +
      `(both resolved to "${input.author.toolId}" for steps "${input.authorStepId}" and "${input.reviewerStepId}"). ` +
      `Change the workflow default reviewer, set a per-step agent override, or disable reviewer independence on this step.`
    );
  }

  const authorPinned = hasPinnedModelPool(
    input.authorStepId,
    input.workflowId,
    input.taskModelPoolOverrides,
    input.workflowModelPoolOverrides
  );
  const reviewerPinned = hasPinnedModelPool(
    input.reviewerStepId,
    input.workflowId,
    input.taskModelPoolOverrides,
    input.workflowModelPoolOverrides
  );
  if (
    authorPinned &&
    reviewerPinned &&
    input.author.modelPoolId === input.reviewer.modelPoolId
  ) {
    return (
      `Reviewer independence requires distinct model pools when both steps pin a pool ` +
      `(both resolved to "${input.author.modelPoolId}" for steps "${input.authorStepId}" and "${input.reviewerStepId}"). ` +
      `Clear one pool override or choose a different model for the reviewer step.`
    );
  }

  return null;
}
