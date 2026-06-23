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

function anchorPoints(
  from: NodeRect,
  to: NodeRect,
  kind: LayoutEdge["kind"]
): { x1: number; y1: number; x2: number; y2: number } {
  const fromCenterX = from.left + from.width / 2;
  const toCenterX = to.left + to.width / 2;

  if (kind === "branch") {
    return {
      x1: from.left + from.width,
      y1: from.top,
      x2: to.left + to.width,
      y2: to.top + to.height
    };
  }

  return {
    x1: fromCenterX,
    y1: from.top + from.height,
    x2: toCenterX,
    y2: to.top
  };
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
        branch: edge.kind === "branch"
      };
    })
    .filter((edge): edge is EdgeGeometry => edge !== null);
}

export interface BranchEdgeGeometry {
  from: string;
  to: string;
  path: string;
  bowX: number;
  labelX: number;
  labelY: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Branch (remediation / rework) edges loop backward to an earlier step that
 * usually sits in the same column — drawn as a straight line they collapse into
 * an unreadable vertical stripe over the nodes between them. Instead we route
 * each one as a cubic bezier that exits the right side of the source, bows out
 * clear of the whole column, and re-enters the right side of the target. Multiple
 * back-edges are staggered (bowX + index) and vertically fanned so they never
 * stack on top of one another.
 */
export function computeBranchEdgeGeometry(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): BranchEdgeGeometry[] {
  const byId = new Map(nodes.map((node) => [node.id, nodeRect(node)]));
  const maxRight = nodes.reduce(
    (max, node) => Math.max(max, node.x + LAYOUT.NODE_WIDTH),
    0
  );
  const branches = edges.filter((edge) => edge.kind === "branch");

  return branches
    .map((edge, index) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return null;

      const sx = from.left + from.width;
      const sy = from.top + from.height / 2;
      const ex = to.left + to.width;
      const fan = (index - (branches.length - 1) / 2) * 12;
      const ey = to.top + to.height / 2 + fan;
      const bowX = maxRight + 56 + index * 32;

      const path =
        `M ${round(sx)} ${round(sy)} ` +
        `C ${round(bowX)} ${round(sy)}, ${round(bowX)} ${round(ey)}, ${round(ex)} ${round(ey)}`;
      // The cubic's rightmost extent sits ~72% of the way to the control x.
      const labelX = round(sx + (bowX - sx) * 0.72);
      const labelY = round((sy + ey) / 2);

      return { from: edge.from, to: edge.to, path, bowX: round(bowX), labelX, labelY };
    })
    .filter((edge): edge is BranchEdgeGeometry => edge !== null);
}