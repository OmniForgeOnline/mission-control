/* Pure view-transform math for the workflow canvas.
 *
 * The same WorkflowCanvas is used in two very different viewports:
 *   - "panel": the narrow, scrollable ticket-detail sidebar. Nodes must stay
 *     readable, so the fit keeps a high minimum scale and pins the graph to
 *     the top.
 *   - "contain": the wide workflow editor canvas. The goal is to see the whole
 *     workflow at once, so the fit may shrink the graph to fit the viewport
 *     height and centers it vertically.
 *
 * Scale is derived from the padded bounds box. Horizontal placement uses the
 * tighter rendered content box so a workflow does not load shifted away from
 * the visible content. Kept Preact-free so it is unit-testable in isolation. */

export interface FitBounds {
  width: number;
  height: number;
}

export interface FitContent {
  minX: number;
  maxX: number;
}

export interface FitTransform {
  x: number;
  y: number;
  scale: number;
}

export interface FitMode {
  /** Lower bound for the fitted scale. */
  minScale: number;
  /** Upper bound for the fitted scale. */
  maxScale: number;
  /** Center vertically when content is shorter than the viewport (vs pin to top). */
  centerY: boolean;
}

/** Absolute pan/zoom clamps shared by the canvas zoom controls. */
export const ZOOM_MIN_SCALE = 0.4;
export const ZOOM_MAX_SCALE = 1.8;

/** Ticket-detail sidebar: keep nodes readable, pin to top. */
export const PANEL_FIT: FitMode = { minScale: 1.12, maxScale: 1.5, centerY: false };

/** Workflow editor: fit the whole graph and center it. */
export const CONTAIN_FIT: FitMode = { minScale: ZOOM_MIN_SCALE, maxScale: 1, centerY: true };

const FIT_PAD = 48;
const LEFT_EDGE_GUARD = 16;
const TOP_PIN = 24;

export const DEFAULT_TRANSFORM: FitTransform = {
  x: 120,
  y: TOP_PIN,
  scale: PANEL_FIT.minScale
};

export function clampZoom(scale: number): number {
  return Math.min(ZOOM_MAX_SCALE, Math.max(ZOOM_MIN_SCALE, scale));
}

export function computeFitTransform(
  viewportWidth: number,
  viewportHeight: number,
  bounds: FitBounds,
  content: FitContent,
  mode: FitMode
): FitTransform {
  if (!viewportWidth || !viewportHeight || !bounds.width || !bounds.height) {
    return { ...DEFAULT_TRANSFORM, scale: clampZoom(mode.minScale) };
  }

  const widthScale = (viewportWidth - FIT_PAD) / bounds.width;
  const heightScale = (viewportHeight - FIT_PAD) / bounds.height;
  const natural = Math.min(widthScale, heightScale);
  const bounded = Math.min(Math.max(natural, mode.minScale), mode.maxScale);
  const scale = clampZoom(bounded);

  const contentWidth = content.maxX - content.minX;
  const contentCenter = (content.minX + content.maxX) / 2;
  const centeredX = viewportWidth / 2 - contentCenter * scale;
  const x =
    contentWidth * scale <= viewportWidth
      ? centeredX
      : LEFT_EDGE_GUARD - content.minX * scale;
  const y = mode.centerY ? Math.max(LEFT_EDGE_GUARD, (viewportHeight - bounds.height * scale) / 2) : TOP_PIN;

  return { x, y, scale };
}
