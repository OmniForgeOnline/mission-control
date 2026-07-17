export const LAYOUT = {
  NODE_WIDTH: 196,
  NODE_HEIGHT: 110,
  /** Horizontal step spacing along the flow (left → right). */
  COL_WIDTH: 220,
  /** Vertical spacing between parallel lanes. */
  LANE_HEIGHT: 128,
  LEFT_PADDING: 20,
  TOP_PADDING: 20,
  /** Outer padding added around content when computing canvas bounds. */
  BOUNDS_PAD: 28,
  LANE_GROUP_PAD: 12,
  LANE_GROUP_EXTRA_WIDTH: 20,
  // Legacy aliases for older call sites / tests.
  CENTER_X: 300,
  CENTER_Y: 20,
  LANE_WIDTH: 220,
  ROW_HEIGHT: 128,
  LANE_GROUP_HEIGHT: 120
} as const;

export type LayoutEdgeKind = "sequential" | "fan-out" | "fan-in" | "branch";

export interface LayoutStepDef {
  next?: string;
  parallel?: string[];
  join?: string;
  branch?: Record<string, string>;
}

export interface LayoutWorkflowInput {
  initial: string;
  steps: Record<string, LayoutStepDef>;
  gitPipeline?: { remediationStepId: string };
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  /** Lane offset from the main spine (parallel jobs). */
  column: number;
  /** Index along the left→right flow. */
  row: number;
  parallelGroup?: string;
}

export interface LayoutEdge {
  from: string;
  to: string;
  kind: LayoutEdgeKind;
}

export interface LaneGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  stepIds: string[];
}

export interface WorkflowLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  laneGroups: LaneGroup[];
  bounds: { width: number; height: number };
  /** Tight content box of nodes + lane groups (used for fit, not the padded bounds). */
  content: { minX: number; maxX: number; minY: number; maxY: number };
}

interface Placement {
  row: number;
  column: number;
  parallelGroup?: string;
}

function distributeColumns(count: number): number[] {
  if (count <= 1) return [0];
  const cols: number[] = [];
  for (let i = 0; i < count; i++) {
    cols.push(i - Math.floor((count - 1) / 2));
  }
  return cols;
}

/** Flow position → canvas x (left → right). */
function flowX(row: number): number {
  return LAYOUT.LEFT_PADDING + row * LAYOUT.COL_WIDTH;
}

function edgeKey(from: string, to: string, kind: LayoutEdgeKind): string {
  return `${from}->${to}:${kind}`;
}

/**
 * Lay out the workflow left-to-right. `row` advances along the flow (x);
 * `column` is the parallel lane offset (y).
 */
export function layoutWorkflow(input: LayoutWorkflowInput): WorkflowLayout {
  const placements = new Map<string, Placement>();
  const edgeSeen = new Set<string>();
  const edges: LayoutEdge[] = [];

  function addEdge(from: string, to: string, kind: LayoutEdgeKind): void {
    if (!input.steps[from] || !input.steps[to]) return;
    const key = edgeKey(from, to, kind);
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to, kind });
  }

  function place(stepId: string, row: number, column: number, parallelGroup?: string): void {
    placements.set(
      stepId,
      parallelGroup ? { row, column, parallelGroup } : { row, column }
    );
  }

  function maxPlacedRow(): number {
    let max = -1;
    for (const p of placements.values()) {
      if (p.row > max) max = p.row;
    }
    return max;
  }

  function walk(stepId: string, row: number, column: number, parallelGroup?: string): number {
    if (placements.has(stepId)) {
      return placements.get(stepId)!.row;
    }

    const step = input.steps[stepId];
    if (!step) return row;

    place(stepId, row, column, parallelGroup);

    if (step.parallel?.length) {
      const parallelRow = row + 1;
      const columns = distributeColumns(step.parallel.length);
      const joinId = step.parallel.map((id) => input.steps[id]?.join).find(Boolean);

      for (let i = 0; i < step.parallel.length; i++) {
        const childId = step.parallel[i]!;
        place(childId, parallelRow, columns[i]!, stepId);
        addEdge(stepId, childId, "fan-out");
      }

      if (joinId) {
        const joinRow = parallelRow + 1;
        const endRow = walk(joinId, joinRow, 0);
        for (const childId of step.parallel) {
          addEdge(childId, joinId, "fan-in");
        }
        return endRow;
      }

      return parallelRow;
    }

    let furthest = row;
    if (step.next) {
      const nextRow = row + 1;
      furthest = Math.max(furthest, walk(step.next, nextRow, 0));
      addEdge(stepId, step.next, "sequential");
    }

    if (step.branch) {
      for (const targetId of Object.values(step.branch)) {
        const existing = placements.get(targetId);
        const remediation =
          input.gitPipeline?.remediationStepId === targetId ||
          (existing !== undefined && existing.row < row);
        const targetRow = remediation ? (existing?.row ?? Math.max(0, row - 2)) : row + 1;
        if (!placements.has(targetId)) {
          furthest = Math.max(furthest, walk(targetId, targetRow, 0));
        }
        addEdge(stepId, targetId, remediation ? "branch" : "sequential");
      }
    }

    return furthest;
  }

  walk(input.initial, 0, 0);

  for (const stepId of Object.keys(input.steps)) {
    if (!placements.has(stepId)) {
      walk(stepId, maxPlacedRow() + 1, 0);
    }
  }

  // Map parallel columns to y starting at TOP_PADDING so the graph is not
  // floating in empty vertical space (no centered spine gap).
  let minColumn = 0;
  for (const p of placements.values()) {
    if (p.column < minColumn) minColumn = p.column;
  }

  const nodes: LayoutNode[] = [...placements.entries()].map(([id, p]) => ({
    id,
    x: flowX(p.row),
    y: LAYOUT.TOP_PADDING + (p.column - minColumn) * LAYOUT.LANE_HEIGHT,
    column: p.column,
    row: p.row,
    ...(p.parallelGroup ? { parallelGroup: p.parallelGroup } : {})
  }));

  const laneGroups: LaneGroup[] = [];
  const groups = new Map<string, LayoutNode[]>();
  for (const node of nodes) {
    if (!node.parallelGroup) continue;
    const list = groups.get(node.parallelGroup) ?? [];
    list.push(node);
    groups.set(node.parallelGroup, list);
  }

  for (const [groupId, members] of groups) {
    const minY = Math.min(...members.map((n) => n.y));
    const maxY = Math.max(...members.map((n) => n.y)) + LAYOUT.NODE_HEIGHT;
    const x = members[0]!.x;
    laneGroups.push({
      id: groupId,
      label: groupId.replace(/_/g, " "),
      x: x - LAYOUT.LANE_GROUP_PAD,
      y: minY - 18,
      width: LAYOUT.NODE_WIDTH + LAYOUT.LANE_GROUP_PAD * 2 + LAYOUT.LANE_GROUP_EXTRA_WIDTH,
      height: maxY - minY + 28,
      stepIds: members.map((n) => n.id)
    });
  }

  const extent = contentExtent(nodes, laneGroups);
  const maxX = nodes.length
    ? Math.max(...nodes.map((n) => n.x + LAYOUT.NODE_WIDTH), LAYOUT.LEFT_PADDING + LAYOUT.NODE_WIDTH)
    : LAYOUT.LEFT_PADDING + LAYOUT.NODE_WIDTH;
  const maxY = nodes.length
    ? Math.max(...nodes.map((n) => n.y + LAYOUT.NODE_HEIGHT), LAYOUT.TOP_PADDING + LAYOUT.NODE_HEIGHT)
    : LAYOUT.TOP_PADDING + LAYOUT.NODE_HEIGHT;

  return {
    nodes,
    edges,
    laneGroups,
    bounds: {
      width: maxX + LAYOUT.BOUNDS_PAD,
      height: maxY + LAYOUT.BOUNDS_PAD
    },
    content: extent
  };
}

function contentExtent(
  nodes: LayoutNode[],
  laneGroups: LaneGroup[]
): { minX: number; maxX: number; minY: number; maxY: number } {
  if (!nodes.length) {
    return {
      minX: 0,
      maxX: LAYOUT.LEFT_PADDING + LAYOUT.NODE_WIDTH,
      minY: 0,
      maxY: LAYOUT.TOP_PADDING + LAYOUT.NODE_HEIGHT
    };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x + LAYOUT.NODE_WIDTH);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y + LAYOUT.NODE_HEIGHT);
  }
  for (const group of laneGroups) {
    minX = Math.min(minX, group.x);
    maxX = Math.max(maxX, group.x + group.width);
    minY = Math.min(minY, group.y);
    maxY = Math.max(maxY, group.y + group.height);
  }
  return { minX, maxX, minY, maxY };
}

export function layoutFromWorkflowSummary(
  workflow: {
    initial: string;
    steps: Record<string, LayoutStepDef>;
    gitPipeline?: { remediationStepId: string };
  }
): WorkflowLayout {
  return layoutWorkflow({
    initial: workflow.initial,
    steps: workflow.steps,
    ...(workflow.gitPipeline ? { gitPipeline: workflow.gitPipeline } : {})
  });
}
