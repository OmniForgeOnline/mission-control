import { LAYOUT, type LayoutEdge, type LayoutNode } from "./layout.js";

export interface NodeRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface EdgeGeometry {
  from: string;
  to: string;
  kind: LayoutEdge["kind"];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  angleDeg: number;
  branch: boolean;
  /** Orthogonal SVG path (right-angle routing). */
  path: string;
}

function nodeRect(node: LayoutNode): NodeRect {
  return {
    id: node.id,
    left: node.x,
    top: node.y,
    width: LAYOUT.NODE_WIDTH,
    height: LAYOUT.NODE_HEIGHT
  };
}

/**
 * Horizontal flow anchors: sequential / fan edges leave the right side of the
 * source and enter the left side of the target. Branch (rework) edges leave the
 * bottom and re-enter the bottom of an earlier step.
 */
function anchorPoints(
  from: NodeRect,
  to: NodeRect,
  kind: LayoutEdge["kind"]
): { x1: number; y1: number; x2: number; y2: number } {
  const fromCenterY = from.top + from.height / 2;
  const toCenterY = to.top + to.height / 2;

  if (kind === "branch") {
    return {
      x1: from.left + from.width / 2,
      y1: from.top + from.height,
      x2: to.left + to.width / 2,
      y2: to.top + to.height
    };
  }

  return {
    x1: from.left + from.width,
    y1: fromCenterY,
    x2: to.left,
    y2: toCenterY
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Forward edge as a right-angle path: horizontal → vertical → horizontal.
 * Collinear ports collapse to a single straight segment.
 */
export function orthogonalForwardPath(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y1 - y2) < 0.5) {
    return `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}`;
  }
  const midX = round((x1 + x2) / 2);
  return (
    `M ${round(x1)} ${round(y1)} ` +
    `L ${midX} ${round(y1)} ` +
    `L ${midX} ${round(y2)} ` +
    `L ${round(x2)} ${round(y2)}`
  );
}

/**
 * Rework back-edge as a U-shaped orthogonal path that drops below the graph,
 * runs horizontally, then rises into the target. Sharp corners only (no curves).
 */
export function orthogonalBranchPath(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  bowY: number
): string {
  return (
    `M ${round(sx)} ${round(sy)} ` +
    `L ${round(sx)} ${round(bowY)} ` +
    `L ${round(ex)} ${round(bowY)} ` +
    `L ${round(ex)} ${round(ey)}`
  );
}

export function computeEdgeGeometry(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): EdgeGeometry[] {
  const byId = new Map(nodes.map((node) => [node.id, nodeRect(node)]));

  return edges
    .map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return null;

      const { x1, y1, x2, y2 } = anchorPoints(from, to, edge.kind);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      const branch = edge.kind === "branch";

      return {
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        x1,
        y1,
        x2,
        y2,
        length,
        angleDeg,
        branch,
        path: branch ? "" : orthogonalForwardPath(x1, y1, x2, y2)
      };
    })
    .filter((edge): edge is EdgeGeometry => edge !== null);
}

export interface BranchEdgeGeometry {
  from: string;
  to: string;
  path: string;
  bowY: number;
  labelX: number;
  labelY: number;
}

/**
 * Branch (remediation / rework) edges loop backward to an earlier step on the
 * left→right spine. Straight diagonals would cut intermediate nodes, so each
 * back-edge exits the bottom, runs under the graph on orthogonal segments,
 * and re-enters the bottom of the target. Multiple back-edges are staggered.
 */
export function computeBranchEdgeGeometry(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): BranchEdgeGeometry[] {
  const byId = new Map(nodes.map((node) => [node.id, nodeRect(node)]));
  const maxBottom = nodes.reduce(
    (max, node) => Math.max(max, node.y + LAYOUT.NODE_HEIGHT),
    0
  );
  const branches = edges.filter((edge) => edge.kind === "branch");

  return branches
    .map((edge, index) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return null;

      const sx = from.left + from.width / 2;
      const sy = from.top + from.height;
      // Slight horizontal stagger so multi-rework targets stay distinct without a wide fan.
      const fan = (index - (branches.length - 1) / 2) * 10;
      const ex = to.left + to.width / 2 + fan;
      const ey = to.top + to.height;
      // Keep U-paths close under the spine; stack multiple reworks tightly.
      const bowY = maxBottom + 20 + index * 16;

      const path = orthogonalBranchPath(sx, sy, ex, ey, bowY);
      const labelX = round((sx + ex) / 2);
      // Sit the label on the horizontal run under the graph.
      const labelY = round(bowY);

      return { from: edge.from, to: edge.to, path, bowY: round(bowY), labelX, labelY };
    })
    .filter((edge): edge is BranchEdgeGeometry => edge !== null);
}
