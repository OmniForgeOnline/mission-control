// Bottom details panel (step/terminal) vs top workflow canvas.
// Default: short workflow strip. User can drag the splitter to grow the canvas.

// Fallback before the body has been measured (panel-biased).
export const DEFAULT_WORKFLOW_PANEL_HEIGHT = 520;
export const MIN_WORKFLOW_PANEL_HEIGHT = 180;
export const MAX_WORKFLOW_PANEL_HEIGHT = 1200;
/** Floor so the strip never collapses under the nodes. */
export const MIN_WORKFLOW_CANVAS_HEIGHT = 140;
/**
 * Default height of the workflow canvas strip on first load — bare minimum for
 * a full horizontal node row (+ fit padding / rework).
 */
export const DEFAULT_WORKFLOW_CANVAS_HEIGHT = 168;
/**
 * How far the user can expand the canvas by dragging the splitter down.
 * Relative cap is applied in clamp() as a fraction of body height.
 */
export const MAX_WORKFLOW_CANVAS_HEIGHT = 720;
export const WORKFLOW_SPLITTER_HEIGHT = 6;
/** Collapsed bar height (expand control only). */
export const COLLAPSED_WORKFLOW_PANEL_HEIGHT = 36;

/** Max share of the body the canvas may occupy when the user expands it. */
const MAX_CANVAS_BODY_FRACTION = 0.7;

const STORAGE_HEIGHT_KEY = "harness:wf-panel-height";
const STORAGE_COLLAPSED_KEY = "harness:wf-panel-collapsed";

let storedPanelHeight: number | null = null;
let storedCollapsed: boolean | null = null;

function readStoredHeight(): number | null {
  if (storedPanelHeight !== null) return storedPanelHeight;
  try {
    const raw = localStorage.getItem(STORAGE_HEIGHT_KEY);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < MIN_WORKFLOW_PANEL_HEIGHT) return null;
    storedPanelHeight = n;
    return n;
  } catch {
    return null;
  }
}

function readStoredCollapsed(): boolean {
  if (storedCollapsed !== null) return storedCollapsed;
  try {
    storedCollapsed = localStorage.getItem(STORAGE_COLLAPSED_KEY) === "1";
    return storedCollapsed;
  } catch {
    return false;
  }
}

export function getWorkflowPanelHeight(): number {
  return readStoredHeight() ?? DEFAULT_WORKFLOW_PANEL_HEIGHT;
}

export function setWorkflowPanelHeight(height: number): void {
  storedPanelHeight = height;
  try {
    localStorage.setItem(STORAGE_HEIGHT_KEY, String(height));
  } catch {
    /* ignore */
  }
}

/** True once the operator has dragged/keyed the splitter (or we restored a stored height). */
export function hasStoredWorkflowPanelHeight(): boolean {
  return readStoredHeight() !== null;
}

export function getWorkflowPanelCollapsed(): boolean {
  return readStoredCollapsed();
}

export function setWorkflowPanelCollapsed(collapsed: boolean): void {
  storedCollapsed = collapsed;
  try {
    localStorage.setItem(STORAGE_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Max canvas height for this body — allows dragging the strip open. */
export function maxCanvasHeightForBody(bodyHeight: number): number {
  return Math.min(
    MAX_WORKFLOW_CANVAS_HEIGHT,
    Math.floor(bodyHeight * MAX_CANVAS_BODY_FRACTION)
  );
}

export function clampWorkflowPanelHeight(requested: number, bodyHeight: number): number {
  // Canvas height = body - splitter - panel.
  const maxCanvas = maxCanvasHeightForBody(bodyHeight);
  const maxPanel = Math.min(
    MAX_WORKFLOW_PANEL_HEIGHT,
    bodyHeight - MIN_WORKFLOW_CANVAS_HEIGHT - WORKFLOW_SPLITTER_HEIGHT
  );
  const minPanel = Math.max(
    MIN_WORKFLOW_PANEL_HEIGHT,
    bodyHeight - maxCanvas - WORKFLOW_SPLITTER_HEIGHT
  );
  const lo = Math.min(minPanel, maxPanel);
  const hi = Math.max(minPanel, maxPanel);
  return Math.min(Math.max(requested, lo), hi);
}

/**
 * Default bottom-panel height: workflow gets DEFAULT_WORKFLOW_CANVAS_HEIGHT,
 * details get the rest. User can still drag the splitter to grow the canvas.
 */
export function defaultWorkflowPanelHeight(bodyHeight: number): number {
  const panelForDefaultCanvas =
    bodyHeight - WORKFLOW_SPLITTER_HEIGHT - DEFAULT_WORKFLOW_CANVAS_HEIGHT;
  return clampWorkflowPanelHeight(panelForDefaultCanvas, bodyHeight);
}

/** Pointer Y → panel height (distance from bottom of the body). */
export function panelHeightFromPointer(clientY: number, bodyRect: DOMRect): number {
  return clampWorkflowPanelHeight(bodyRect.bottom - clientY, bodyRect.height);
}
