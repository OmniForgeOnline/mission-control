import { describe, expect, it } from "vitest";

import {
  clampWorkflowPanelHeight,
  COLLAPSED_WORKFLOW_PANEL_HEIGHT,
  DEFAULT_WORKFLOW_CANVAS_HEIGHT,
  DEFAULT_WORKFLOW_PANEL_HEIGHT,
  defaultWorkflowPanelHeight,
  MAX_WORKFLOW_CANVAS_HEIGHT,
  maxCanvasHeightForBody,
  MIN_WORKFLOW_CANVAS_HEIGHT,
  MIN_WORKFLOW_PANEL_HEIGHT,
  panelHeightFromPointer,
  WORKFLOW_SPLITTER_HEIGHT
} from "../src/ui/features/tasks/detail/workflow/panel-size.ts";

describe("workflow panel size (vertical split)", () => {
  it("exposes a slim collapsed bar height", () => {
    expect(COLLAPSED_WORKFLOW_PANEL_HEIGHT).toBeLessThan(MIN_WORKFLOW_PANEL_HEIGHT);
    expect(COLLAPSED_WORKFLOW_PANEL_HEIGHT).toBeGreaterThan(0);
  });

  it("defaults tall enough for a terminal pane", () => {
    expect(DEFAULT_WORKFLOW_PANEL_HEIGHT).toBeGreaterThanOrEqual(300);
  });

  it("defaults the canvas strip to a short bare-minimum height", () => {
    const bodyHeight = 1000;
    const panel = defaultWorkflowPanelHeight(bodyHeight);
    const canvas = bodyHeight - WORKFLOW_SPLITTER_HEIGHT - panel;
    expect(canvas).toBe(DEFAULT_WORKFLOW_CANVAS_HEIGHT);
    expect(DEFAULT_WORKFLOW_CANVAS_HEIGHT).toBeLessThan(MAX_WORKFLOW_CANVAS_HEIGHT);
  });

  it("allows the user to expand the canvas past the default by dragging", () => {
    const body = 900;
    const defaultPanel = defaultWorkflowPanelHeight(body);
    // Dragging the splitter down reduces panel height → grows canvas.
    const expandedCanvas = 400;
    const panelForExpanded = body - WORKFLOW_SPLITTER_HEIGHT - expandedCanvas;
    const clamped = clampWorkflowPanelHeight(panelForExpanded, body);
    const canvas = body - WORKFLOW_SPLITTER_HEIGHT - clamped;
    expect(canvas).toBeGreaterThan(DEFAULT_WORKFLOW_CANVAS_HEIGHT);
    expect(canvas).toBeLessThanOrEqual(maxCanvasHeightForBody(body));
    expect(clamped).toBeLessThan(defaultPanel);
  });

  it("never shrinks the canvas under the node-row floor", () => {
    const body = 900;
    const maxPanel = body - MIN_WORKFLOW_CANVAS_HEIGHT - WORKFLOW_SPLITTER_HEIGHT;
    expect(clampWorkflowPanelHeight(5000, body)).toBe(maxPanel);
  });

  it("derives panel height from pointer position against the body bottom", () => {
    const rect = {
      width: 1000,
      height: 800,
      right: 1000,
      left: 0,
      top: 100,
      bottom: 900,
      x: 0,
      y: 100,
      toJSON: () => ({})
    } as Parameters<typeof panelHeightFromPointer>[1];

    const value = panelHeightFromPointer(540, rect);
    expect(value).toBeGreaterThanOrEqual(MIN_WORKFLOW_PANEL_HEIGHT);
  });
});
