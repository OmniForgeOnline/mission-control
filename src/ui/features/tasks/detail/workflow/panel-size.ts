// The side panel takes 40% of the workflow body by default — a 60/40
// canvas/panel split — then stays where the operator drags it.
export const DEFAULT_WORKFLOW_PANEL_RATIO = 0.4;
// Fallback used before the body has been measured (first paint / no layout yet).
export const DEFAULT_WORKFLOW_PANEL_WIDTH = 440;
export const MIN_WORKFLOW_PANEL_WIDTH = 300;
export const MAX_WORKFLOW_PANEL_WIDTH = 720;
export const MIN_WORKFLOW_CANVAS_WIDTH = 320;
export const WORKFLOW_SPLITTER_WIDTH = 6;

let storedPanelWidth: number | null = null;

export function getWorkflowPanelWidth(): number {
  return storedPanelWidth ?? DEFAULT_WORKFLOW_PANEL_WIDTH;
}

export function setWorkflowPanelWidth(width: number): void {
  storedPanelWidth = width;
}

/** True once the operator has dragged/keyed the splitter, so the ratio default no longer applies. */
export function hasStoredWorkflowPanelWidth(): boolean {
  return storedPanelWidth !== null;
}

export function clampWorkflowPanelWidth(requested: number, bodyWidth: number): number {
  const max = Math.min(
    MAX_WORKFLOW_PANEL_WIDTH,
    bodyWidth - MIN_WORKFLOW_CANVAS_WIDTH - WORKFLOW_SPLITTER_WIDTH
  );
  return Math.min(Math.max(requested, MIN_WORKFLOW_PANEL_WIDTH), Math.max(MIN_WORKFLOW_PANEL_WIDTH, max));
}

/** The 60/40 default for a given body width, clamped to the panel's min/max bounds. */
export function defaultWorkflowPanelWidth(bodyWidth: number): number {
  return clampWorkflowPanelWidth(
    Math.round((bodyWidth - WORKFLOW_SPLITTER_WIDTH) * DEFAULT_WORKFLOW_PANEL_RATIO),
    bodyWidth
  );
}

export function panelWidthFromPointer(clientX: number, bodyRect: DOMRect): number {
  return clampWorkflowPanelWidth(bodyRect.right - clientX, bodyRect.width);
}
