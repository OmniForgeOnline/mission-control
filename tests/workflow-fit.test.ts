import { describe, expect, it } from "vitest";

import {
  CONTAIN_FIT,
  PANEL_FIT,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
  clampZoom,
  computeFitTransform
} from "../src/ui/features/tasks/detail/workflow/fit.ts";
import { LAYOUT, layoutWorkflow } from "../src/ui/features/tasks/detail/workflow/layout.ts";

const DETAIL_VIEWPORT = { width: 800, height: 520 };
const EDITOR_VIEWPORT = { width: 1400, height: 760 };
const TALL = { width: 728, height: 1400 };
const SHORT = { width: 728, height: 400 };

const linearLayout = layoutWorkflow({
  initial: "a",
  steps: { a: { next: "b" }, b: { next: "c" }, c: {} }
});

const parallelLayout = layoutWorkflow({
  initial: "plan",
  steps: {
    plan: { next: "implement" },
    implement: { parallel: ["lint", "unit", "typecheck"] },
    lint: { join: "join" },
    unit: { join: "join" },
    typecheck: { join: "join" },
    join: { next: "done" },
    done: {}
  }
});

describe("computeFitTransform", () => {
  it("panel mode keeps a tall graph at the readable minimum and pins it to the top", () => {
    const t = computeFitTransform(
      EDITOR_VIEWPORT.width,
      EDITOR_VIEWPORT.height,
      TALL,
      { minX: 0, maxX: TALL.width },
      PANEL_FIT
    );
    expect(t.scale).toBe(PANEL_FIT.minScale);
    expect(t.y).toBe(24);
  });

  it("contain mode shrinks a tall graph so the whole thing fits the viewport height", () => {
    const t = computeFitTransform(
      EDITOR_VIEWPORT.width,
      EDITOR_VIEWPORT.height,
      TALL,
      { minX: 0, maxX: TALL.width },
      CONTAIN_FIT
    );
    expect(t.scale).toBeLessThan(PANEL_FIT.minScale);
    expect(t.scale).toBeGreaterThanOrEqual(ZOOM_MIN_SCALE);
    expect(TALL.height * t.scale).toBeLessThanOrEqual(EDITOR_VIEWPORT.height);
  });

  it("contain mode centers a short graph vertically instead of pinning it to the top", () => {
    const t = computeFitTransform(
      EDITOR_VIEWPORT.width,
      EDITOR_VIEWPORT.height,
      SHORT,
      { minX: 0, maxX: SHORT.width },
      CONTAIN_FIT
    );
    expect(t.y).toBeGreaterThan(24);
    expect(t.y).toBeCloseTo((EDITOR_VIEWPORT.height - SHORT.height * t.scale) / 2, 1);
    expect(t.scale).toBeLessThanOrEqual(CONTAIN_FIT.maxScale);
  });

  it("centers a linear workflow's rendered content horizontally on initial load", () => {
    const { x, scale } = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      linearLayout.bounds,
      linearLayout.content,
      PANEL_FIT
    );

    const contentCenter = (linearLayout.content.minX + linearLayout.content.maxX) / 2;
    expect(x + contentCenter * scale).toBeCloseTo(DETAIL_VIEWPORT.width / 2, 0);
  });

  it("centers a parallel workflow's rendered content symmetrically", () => {
    const { x, scale } = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      parallelLayout.bounds,
      parallelLayout.content,
      PANEL_FIT
    );

    const contentCenter = (parallelLayout.content.minX + parallelLayout.content.maxX) / 2;
    expect(x + contentCenter * scale).toBeCloseTo(DETAIL_VIEWPORT.width / 2, 0);
  });

  it("keeps fitted content fully inside the viewport when it fits", () => {
    const { x, scale } = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      linearLayout.bounds,
      linearLayout.content,
      PANEL_FIT
    );

    const leftEdge = x + linearLayout.content.minX * scale;
    const rightEdge = x + linearLayout.content.maxX * scale;
    expect(leftEdge).toBeGreaterThanOrEqual(0);
    expect(rightEdge).toBeLessThanOrEqual(DETAIL_VIEWPORT.width);
  });

  it("does not change scale based on content position", () => {
    const bounds = linearLayout.bounds;
    const a = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      bounds,
      { minX: 0, maxX: 100 },
      PANEL_FIT
    );
    const b = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      bounds,
      { minX: 300, maxX: 496 },
      PANEL_FIT
    );
    expect(a.scale).toBe(b.scale);
  });

  it("left-aligns content that is wider than the viewport", () => {
    const wideBounds = { width: 1200, height: 200 };
    const wideContent = { minX: 0, maxX: 1200 };
    const { x, scale } = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      wideBounds,
      wideContent,
      PANEL_FIT
    );

    expect(x + wideContent.minX * scale).toBeCloseTo(16, 5);
  });

  it("never exceeds the absolute zoom clamps", () => {
    const t = computeFitTransform(
      EDITOR_VIEWPORT.width,
      EDITOR_VIEWPORT.height,
      SHORT,
      { minX: 0, maxX: SHORT.width },
      CONTAIN_FIT
    );
    expect(t.scale).toBeGreaterThanOrEqual(ZOOM_MIN_SCALE);
    expect(t.scale).toBeLessThanOrEqual(ZOOM_MAX_SCALE);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN_SCALE);
    expect(clampZoom(10)).toBe(ZOOM_MAX_SCALE);
    expect(clampZoom(1)).toBe(1);
  });

  it("falls back safely when the viewport is unmeasured", () => {
    const t = computeFitTransform(0, 0, TALL, { minX: 0, maxX: TALL.width }, CONTAIN_FIT);
    expect(t.scale).toBeGreaterThanOrEqual(ZOOM_MIN_SCALE);
    expect(Number.isFinite(t.x)).toBe(true);
    expect(Number.isFinite(t.y)).toBe(true);
  });

  it("exposes a content box that tightly brackets the placed nodes", () => {
    for (const layout of [linearLayout, parallelLayout]) {
      const nodeMinX = Math.min(...layout.nodes.map((n) => n.x));
      const nodeMaxX = Math.max(...layout.nodes.map((n) => n.x + LAYOUT.NODE_WIDTH));
      expect(layout.content.minX).toBeLessThanOrEqual(nodeMinX);
      expect(layout.content.maxX).toBeGreaterThanOrEqual(nodeMaxX);
      expect((layout.content.minX + layout.content.maxX) / 2).toBeCloseTo(
        LAYOUT.CENTER_X + LAYOUT.NODE_WIDTH / 2,
        5
      );
    }
  });
});
