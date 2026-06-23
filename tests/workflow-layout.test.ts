import { describe, expect, it } from "vitest";

import {
  computeBranchEdgeGeometry,
  computeEdgeGeometry
} from "../src/ui/features/tasks/detail/workflow/edges.ts";
import {
  LAYOUT,
  layoutWorkflow,
  type LayoutWorkflowInput
} from "../src/ui/features/tasks/detail/workflow/layout.ts";

const parallelFixture: LayoutWorkflowInput = {
  initial: "plan",
  steps: {
    plan: { next: "implement" },
    implement: { parallel: ["lint", "unit", "typecheck"] },
    lint: { join: "create_merge_request" },
    unit: { join: "create_merge_request" },
    typecheck: { join: "create_merge_request" },
    create_merge_request: { next: "review" },
    review: { next: "done" },
    done: {}
  }
};

describe("workflow layout", () => {
  it("places linear steps on the center spine", () => {
    const layout = layoutWorkflow({
      initial: "a",
      steps: {
        a: { next: "b" },
        b: { next: "c" },
        c: {}
      }
    });

    expect(layout.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(layout.nodes.every((n) => n.column === 0)).toBe(true);
    expect(layout.nodes[0]!.y).toBeLessThan(layout.nodes[1]!.y);
    expect(layout.nodes[1]!.y).toBeLessThan(layout.nodes[2]!.y);
    expect(layout.edges).toEqual(
      expect.arrayContaining([
        { from: "a", to: "b", kind: "sequential" },
        { from: "b", to: "c", kind: "sequential" }
      ])
    );
    expect(layout.edges).toHaveLength(2);
  });

  it("fans parallel jobs across lanes and groups them", () => {
    const layout = layoutWorkflow(parallelFixture);
    const parallel = layout.nodes.filter((n) => n.parallelGroup === "implement");

    expect(parallel.map((n) => n.id).sort()).toEqual(["lint", "typecheck", "unit"]);
    expect(new Set(parallel.map((n) => n.row)).size).toBe(1);
    expect(new Set(parallel.map((n) => n.column)).size).toBe(3);

    expect(layout.laneGroups).toHaveLength(1);
    expect(layout.laneGroups[0]!.stepIds.sort()).toEqual(["lint", "typecheck", "unit"]);
    expect(layout.laneGroups[0]!.label).toBe("implement");

    const fanOut = layout.edges.filter((e) => e.kind === "fan-out");
    const fanIn = layout.edges.filter((e) => e.kind === "fan-in");
    expect(fanOut).toHaveLength(3);
    expect(fanIn).toHaveLength(3);
    expect(fanOut.every((e) => e.from === "implement")).toBe(true);
    expect(fanIn.every((e) => e.to === "create_merge_request")).toBe(true);
  });

  it("computes fan-out and fan-in edge geometry from node anchors", () => {
    const layout = layoutWorkflow(parallelFixture);
    const geometry = computeEdgeGeometry(layout.nodes, layout.edges);
    const fanOut = geometry.find((e) => e.from === "implement" && e.to === "lint");
    const fanIn = geometry.find((e) => e.from === "lint" && e.to === "create_merge_request");

    expect(fanOut).toBeDefined();
    expect(fanIn).toBeDefined();
    expect(fanOut!.length).toBeGreaterThan(LAYOUT.LANE_WIDTH * 0.5);
    expect(fanIn!.length).toBeGreaterThan(LAYOUT.ROW_HEIGHT * 0.2);
    expect(fanOut!.branch).toBe(false);
    expect(fanOut!.x1).toBeGreaterThan(fanOut!.x2);
  });

  it("marks remediation edges as branch geometry", () => {
    const layout = layoutWorkflow({
      initial: "implement",
      gitPipeline: { remediationStepId: "implement" },
      steps: {
        implement: { next: "checks" },
        checks: { branch: { failed: "implement", passed: "review" } },
        review: {}
      }
    });

    const branch = layout.edges.find((e) => e.from === "checks" && e.to === "implement");
    expect(branch?.kind).toBe("branch");

    const geometry = computeEdgeGeometry(layout.nodes, layout.edges);
    const branchGeom = geometry.find((e) => e.from === "checks" && e.to === "implement");
    expect(branchGeom?.branch).toBe(true);
    expect(branchGeom!.x1).toBeGreaterThan(branchGeom!.x2 - 1);
  });

  it("routes branch edges as a curve that bows clear of the column", () => {
    const layout = layoutWorkflow({
      initial: "implement",
      gitPipeline: { remediationStepId: "implement" },
      steps: {
        implement: { next: "checks" },
        checks: { branch: { failed: "implement", passed: "review" } },
        review: {}
      }
    });

    const maxRight = Math.max(...layout.nodes.map((n) => n.x + LAYOUT.NODE_WIDTH));
    const branches = computeBranchEdgeGeometry(layout.nodes, layout.edges);

    expect(branches).toHaveLength(1);
    const rework = branches[0]!;
    expect(rework.from).toBe("checks");
    expect(rework.to).toBe("implement");
    // Cubic bezier, not a straight line.
    expect(rework.path.startsWith("M")).toBe(true);
    expect(rework.path).toContain("C");
    // Bows out to the right of every node so it never overlaps the column.
    expect(rework.bowX).toBeGreaterThan(maxRight);
    expect(rework.labelX).toBeGreaterThan(maxRight);
  });

  it("fans multiple branch edges so they do not stack", () => {
    const layout = layoutWorkflow({
      initial: "implement",
      gitPipeline: { remediationStepId: "implement" },
      steps: {
        implement: { next: "review" },
        review: { branch: { changes: "implement", approved: "merge" } },
        merge: { branch: { conflict: "implement", clean: "done" } },
        done: {}
      }
    });

    const branches = computeBranchEdgeGeometry(layout.nodes, layout.edges);
    expect(branches.length).toBeGreaterThanOrEqual(2);
    const bows = branches.map((b) => b.bowX);
    expect(new Set(bows).size).toBe(bows.length);
  });
});