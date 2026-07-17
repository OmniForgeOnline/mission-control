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
  bowY: number;
  labelX: number;
  labelY: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Branch (remediation / rework) edges loop backward to an earlier step on the
 * left→right spine. Straight lines would run over intermediate nodes, so each
 * back-edge exits the bottom, bows below the whole graph, and re-enters the
 * bottom of the target. Multiple back-edges are staggered.
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
      const fan = (index - (branches.length - 1) / 2) * 16;
      const ex = to.left + to.width / 2 + fan;
      const ey = to.top + to.height;
      const bowY = maxBottom + 48 + index * 28;

      const path =
        `M ${round(sx)} ${round(sy)} ` +
        `C ${round(sx)} ${round(bowY)}, ${round(ex)} ${round(bowY)}, ${round(ex)} ${round(ey)}`;
      const labelX = round((sx + ex) / 2);
      const labelY = round(sy + (bowY - sy) * 0.72);

      return { from: edge.from, to: edge.to, path, bowY: round(bowY), labelX, labelY };
    })
    .filter((edge): edge is BranchEdgeGeometry => edge !== null);
}
