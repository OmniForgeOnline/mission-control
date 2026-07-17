/* Pure view-transform math for the workflow canvas.
 *
 * Scale is derived from the padded bounds box. Placement uses the tighter
 * content box so the graph sits flush in the viewport instead of floating in
 * empty plane space. Kept Preact-free so it is unit-testable in isolation. */

export interface FitBounds {
  width: number;
  height: number;
}

export interface FitContent {
  minX: number;
  maxX: number;
  minY?: number;
  maxY?: number;
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
export const ZOOM_MIN_SCALE = 0.45;
export const ZOOM_MAX_SCALE = 1.8;

/**
 * Ticket-detail canvas: fit the graph into the strip and center it so a short
 * left→right flow does not sit stuck in the top-left corner of empty space.
 */
export const PANEL_FIT: FitMode = { minScale: 0.55, maxScale: 1.15, centerY: true };

/** Workflow editor: fit the whole graph and center it. */
export const CONTAIN_FIT: FitMode = { minScale: ZOOM_MIN_SCALE, maxScale: 1, centerY: true };

const FIT_PAD = 32;
const LEFT_EDGE_GUARD = 12;
const TOP_PIN = 12;

export const DEFAULT_TRANSFORM: FitTransform = {
  x: LEFT_EDGE_GUARD,
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

  const contentMinY = content.minY ?? 0;
  const contentMaxY = content.maxY ?? bounds.height;
  const contentWidth = Math.max(1, content.maxX - content.minX);
  const contentHeight = Math.max(1, contentMaxY - contentMinY);

  // Prefer fitting the tight content box so unused bounds padding does not
  // shrink the graph or invent empty vertical space.
  const widthScale = (viewportWidth - FIT_PAD) / contentWidth;
  const heightScale = (viewportHeight - FIT_PAD) / contentHeight;
  const natural = Math.min(widthScale, heightScale);
  const bounded = Math.min(Math.max(natural, mode.minScale), mode.maxScale);
  const scale = clampZoom(bounded);

  const contentCenter = (content.minX + content.maxX) / 2;
  const centeredX = viewportWidth / 2 - contentCenter * scale;
  const x =
    contentWidth * scale <= viewportWidth
      ? centeredX
      : LEFT_EDGE_GUARD - content.minX * scale;

  const contentCenterY = (contentMinY + contentMaxY) / 2;
  const y = mode.centerY
    ? Math.max(LEFT_EDGE_GUARD, viewportHeight / 2 - contentCenterY * scale)
    : TOP_PIN - contentMinY * scale;

  return { x, y, scale };
}
