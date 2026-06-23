import { describe, expect, it } from "vitest";

import {
  clampWorkflowPanelWidth,
  DEFAULT_WORKFLOW_PANEL_RATIO,
  DEFAULT_WORKFLOW_PANEL_WIDTH,
  defaultWorkflowPanelWidth,
  MAX_WORKFLOW_PANEL_WIDTH,
  MIN_WORKFLOW_CANVAS_WIDTH,
  MIN_WORKFLOW_PANEL_WIDTH,
  panelWidthFromPointer,
  WORKFLOW_SPLITTER_WIDTH
} from "../src/ui/features/tasks/detail/workflow/panel-size.ts";

describe("workflow panel size", () => {
  it("defaults wider than the old fixed panel", () => {
    expect(DEFAULT_WORKFLOW_PANEL_WIDTH).toBeGreaterThan(392);
  });

  it("uses a 60/40 canvas/panel ratio for the default", () => {
    expect(DEFAULT_WORKFLOW_PANEL_RATIO).toBe(0.4);
  });

  it("derives the default panel width as 40% of the body, clamped", () => {
    // 40% of a roomy body → panel gets ~40%, canvas keeps ~60%.
    const bodyWidth = 1400;
    const expected = Math.round((bodyWidth - WORKFLOW_SPLITTER_WIDTH) * DEFAULT_WORKFLOW_PANEL_RATIO);
    expect(defaultWorkflowPanelWidth(bodyWidth)).toBe(expected);
    // The 40% result must respect the max bound on very wide bodies.
    expect(defaultWorkflowPanelWidth(4000)).toBe(MAX_WORKFLOW_PANEL_WIDTH);
    // …and the min bound on narrow bodies.
    expect(defaultWorkflowPanelWidth(700)).toBe(MIN_WORKFLOW_PANEL_WIDTH);
  });

  it("clamps panel width between min and max for the body", () => {
    expect(clampWorkflowPanelWidth(200, 1200)).toBe(MIN_WORKFLOW_PANEL_WIDTH);
    expect(clampWorkflowPanelWidth(900, 1200)).toBe(MAX_WORKFLOW_PANEL_WIDTH);
    expect(clampWorkflowPanelWidth(500, 1200)).toBe(500);
  });

  it("never leaves less than the minimum canvas width", () => {
    const bodyWidth = MIN_WORKFLOW_CANVAS_WIDTH + MIN_WORKFLOW_PANEL_WIDTH + WORKFLOW_SPLITTER_WIDTH;
    expect(clampWorkflowPanelWidth(900, bodyWidth)).toBe(MIN_WORKFLOW_PANEL_WIDTH);
  });

  it("derives panel width from pointer position against the body edge", () => {
    const rect = {
      width: 1000,
      right: 1400,
      left: 400,
      top: 0,
      bottom: 0,
      height: 0,
      x: 400,
      y: 0,
      toJSON: () => ({})
    } as Parameters<typeof panelWidthFromPointer>[1];

    expect(panelWidthFromPointer(980, rect)).toBe(420);
    expect(panelWidthFromPointer(1200, rect)).toBe(MIN_WORKFLOW_PANEL_WIDTH);
  });
});