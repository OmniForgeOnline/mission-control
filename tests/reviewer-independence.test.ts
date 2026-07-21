import { describe, expect, it } from "vitest";

import type { ResolvedRouting } from "../src/core/agents/stage-agents.ts";
import { reviewerIndependenceViolation } from "../src/core/review/independence.ts";

function routing(toolId: string, modelPoolId: string): ResolvedRouting {
  return {
    toolId,
    modelPoolId,
    preferred: toolId,
    source: "preferred",
    supportsEffort: false,

    extensions: [],
    extensionEntries: []
  };
}

describe("reviewer independence", () => {
  it("allows distinct author and reviewer agents when independence is required", () => {
    expect(
      reviewerIndependenceViolation({
        required: true,
        author: routing("claude", "claude-default"),
        reviewer: routing("codex", "codex-default"),
        authorStepId: "draft",
        reviewerStepId: "review",
        workflowId: "blog-post"
      })
    ).toBeNull();
  });

  it("blocks review turns when author and reviewer resolve to the same agent", () => {
    const reason = reviewerIndependenceViolation({
      required: true,
      author: routing("claude", "claude-default"),
      reviewer: routing("claude", "claude-default"),
      authorStepId: "draft_response",
      reviewerStepId: "review",
      workflowId: "customer-support"
    });

    expect(reason).toMatch(/different agent/i);
    expect(reason).toContain("draft_response");
    expect(reason).toContain("review");
  });

  it("blocks when both steps pin the same model pool", () => {
    const reason = reviewerIndependenceViolation({
      required: true,
      author: routing("claude", "claude-default"),
      reviewer: routing("codex", "claude-default"),
      authorStepId: "implement",
      reviewerStepId: "review",
      workflowId: "code-feature",
      taskModelPoolOverrides: {
        implement: "claude-default",
        review: "claude-default"
      }
    });

    expect(reason).toMatch(/distinct model pools/i);
  });

  it("skips enforcement when independence is disabled", () => {
    expect(
      reviewerIndependenceViolation({
        required: false,
        author: routing("claude", "claude-default"),
        reviewer: routing("claude", "claude-default"),
        authorStepId: "draft",
        reviewerStepId: "editorial_review",
        workflowId: "blog-post"
      })
    ).toBeNull();
  });
});
