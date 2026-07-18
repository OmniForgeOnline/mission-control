import { describe, expect, it } from "vitest";

import {
  CONTAIN_FIT,
  NARROW_PANEL_FIT,
  PANEL_FIT,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
  clampZoom,
  computeFitTransform,
  panelFitForViewport,
  zoomToward
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
  it("panel mode centers content in the viewport when the graph is short", () => {
    const t = computeFitTransform(
      EDITOR_VIEWPORT.width,
      EDITOR_VIEWPORT.height,
      { width: 800, height: 200 },
      { minX: 0, maxX: 600, minY: 20, maxY: 130 },
      PANEL_FIT
    );
    const contentCenterY = (20 + 130) / 2;
    expect(t.y).toBeCloseTo(EDITOR_VIEWPORT.height / 2 - contentCenterY * t.scale, 1);
    const contentCenterX = 300;
    expect(t.x + contentCenterX * t.scale).toBeCloseTo(EDITOR_VIEWPORT.width / 2, 0);
  });

  it("contain mode shrinks a tall graph so the whole thing fits the viewport height", () => {
    const t = computeFitTransform(
      EDITOR_VIEWPORT.width,
      EDITOR_VIEWPORT.height,
      TALL,
      { minX: 0, maxX: TALL.width, minY: 0, maxY: TALL.height },
      CONTAIN_FIT
    );
    expect(t.scale).toBeLessThan(1);
    expect(t.scale).toBeGreaterThanOrEqual(ZOOM_MIN_SCALE);
    expect(TALL.height * t.scale).toBeLessThanOrEqual(EDITOR_VIEWPORT.height);
  });

  it("contain mode centers a short graph vertically instead of pinning it to the top", () => {
    const t = computeFitTransform(
      EDITOR_VIEWPORT.width,
      EDITOR_VIEWPORT.height,
      SHORT,
      { minX: 0, maxX: SHORT.width, minY: 0, maxY: SHORT.height },
      CONTAIN_FIT
    );
    expect(t.y).toBeGreaterThan(12);
    expect(t.y).toBeCloseTo(EDITOR_VIEWPORT.height / 2 - (SHORT.height / 2) * t.scale, 1);
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

  it("centers a linear workflow vertically in the canvas strip", () => {
    const { y, scale } = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      linearLayout.bounds,
      linearLayout.content,
      PANEL_FIT
    );
    const contentCenterY = (linearLayout.content.minY + linearLayout.content.maxY) / 2;
    expect(y + contentCenterY * scale).toBeCloseTo(DETAIL_VIEWPORT.height / 2, 0);
  });

  it("centers a parallel workflow when it fits, else left-aligns", () => {
    const { x, scale } = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      parallelLayout.bounds,
      parallelLayout.content,
      PANEL_FIT
    );

    const contentWidth = parallelLayout.content.maxX - parallelLayout.content.minX;
    const contentCenter = (parallelLayout.content.minX + parallelLayout.content.maxX) / 2;
    if (contentWidth * scale > DETAIL_VIEWPORT.width) {
      expect(x).toBeCloseTo(12 - parallelLayout.content.minX * scale, 0);
    } else {
      expect(x + contentCenter * scale).toBeCloseTo(DETAIL_VIEWPORT.width / 2, 0);
    }
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
    expect(leftEdge).toBeGreaterThanOrEqual(-1);
    expect(rightEdge).toBeLessThanOrEqual(DETAIL_VIEWPORT.width + 1);
  });

  it("does not change scale based on content position", () => {
    const bounds = linearLayout.bounds;
    const a = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      bounds,
      { minX: 0, maxX: 400, minY: 0, maxY: 200 },
      PANEL_FIT
    );
    const b = computeFitTransform(
      DETAIL_VIEWPORT.width,
      DETAIL_VIEWPORT.height,
      bounds,
      { minX: 200, maxX: 600, minY: 40, maxY: 240 },
      PANEL_FIT
    );
    expect(a.scale).toBe(b.scale);
  });

  it("never exceeds the absolute zoom clamps", () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN_SCALE);
    expect(clampZoom(10)).toBe(ZOOM_MAX_SCALE);
    expect(clampZoom(1)).toBe(1);
  });

  it("uses a lower panel fit floor on narrow viewports", () => {
    expect(panelFitForViewport(390)).toEqual(NARROW_PANEL_FIT);
    expect(panelFitForViewport(800)).toEqual(PANEL_FIT);
    expect(NARROW_PANEL_FIT.minScale).toBeLessThan(PANEL_FIT.minScale);
  });

  it("zooms toward a viewport point without drifting the under-cursor plane point", () => {
    const current = { x: 40, y: 20, scale: 1 };
    const next = zoomToward(current, 0, 0, 100, 80, 1.5);
    expect(next.scale).toBe(1.5);
    // Plane point under (100,80) before: ((100-40)/1, (80-20)/1) = (60, 60)
    // After: (100 - 60*1.5, 80 - 60*1.5) = (10, -10)
    expect(next.x).toBeCloseTo(10, 5);
    expect(next.y).toBeCloseTo(-10, 5);
  });

  it("fits a wide graph into a phone-width strip using the narrow panel mode", () => {
    const phone = { width: 334, height: 168 };
    const t = computeFitTransform(
      phone.width,
      phone.height,
      parallelLayout.bounds,
      parallelLayout.content,
      panelFitForViewport(phone.width)
    );
    const contentWidth = parallelLayout.content.maxX - parallelLayout.content.minX;
    expect(t.scale).toBeLessThanOrEqual(NARROW_PANEL_FIT.maxScale);
    expect(contentWidth * t.scale).toBeLessThanOrEqual(phone.width + 1);
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
      const nodeMinY = Math.min(...layout.nodes.map((n) => n.y));
      const nodeMaxY = Math.max(...layout.nodes.map((n) => n.y + LAYOUT.NODE_HEIGHT));
      expect(layout.content.minX).toBeLessThanOrEqual(nodeMinX);
      expect(layout.content.maxX).toBeGreaterThanOrEqual(nodeMaxX);
      expect(layout.content.minY).toBeLessThanOrEqual(nodeMinY);
      expect(layout.content.maxY).toBeGreaterThanOrEqual(nodeMaxY);
    }
  });
});
