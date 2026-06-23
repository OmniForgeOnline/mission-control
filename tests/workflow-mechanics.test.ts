import {
  HYBRID_STEP_KINDS,
  MECHANICAL_STEP_KINDS,
  isHybridStepKind,
  isMechanicalStepKind,
  shouldAttachWorkspaceArtifacts
} from "../src/core/workflows/mechanics.ts";

describe("workflow mechanics", () => {
  it("identifies fully programmatic step kinds", () => {
    expect(MECHANICAL_STEP_KINDS).toEqual(["create_merge_request", "terminal"]);
    expect(isMechanicalStepKind("create_merge_request")).toBe(true);
    expect(isMechanicalStepKind("agent_turn")).toBe(false);
  });

  it("identifies hybrid step kinds", () => {
    expect(HYBRID_STEP_KINDS).toEqual(["resolve_conflicts", "review"]);
    expect(isHybridStepKind("resolve_conflicts")).toBe(true);
    expect(isHybridStepKind("review")).toBe(true);
    expect(isHybridStepKind("agent_turn")).toBe(false);
  });

  it("attaches workspace artifacts only for judgment prep skills", () => {
    expect(shouldAttachWorkspaceArtifacts("seo-growth")).toBe(true);
    expect(shouldAttachWorkspaceArtifacts("tech-debt-capture")).toBe(false);
  });
});