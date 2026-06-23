export const LAYOUT = {
  NODE_WIDTH: 196,
  NODE_HEIGHT: 110,
  CENTER_X: 300,
  LANE_WIDTH: 232,
  ROW_HEIGHT: 150,
  TOP_PADDING: 36,
  LANE_GROUP_PAD: 14,
  LANE_GROUP_HEIGHT: 128
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
  column: number;
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
  /** Tight horizontal extent of the rendered content (nodes + lane groups),
   *  used to center the workflow in the canvas viewport. Unlike `bounds` this
   *  excludes the surrounding padding, so centering lands on the real content. */
  content: { minX: number; maxX: number };
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

function colX(column: number): number {
  return LAYOUT.CENTER_X + column * LAYOUT.LANE_WIDTH;
}

function rowY(row: number): number {
  return LAYOUT.TOP_PADDING + row * LAYOUT.ROW_HEIGHT;
}

function edgeKey(from: string, to: string, kind: LayoutEdgeKind): string {
  return `${from}->${to}:${kind}`;
}

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

  const nodes: LayoutNode[] = [...placements.entries()].map(([id, p]) => ({
    id,
    x: colX(p.column),
    y: rowY(p.row),
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
    const minX = Math.min(...members.map((n) => n.x));
    const maxX = Math.max(...members.map((n) => n.x)) + LAYOUT.NODE_WIDTH;
    const y = members[0]!.y;
    laneGroups.push({
      id: groupId,
      label: groupId.replace(/_/g, " "),
      x: minX - LAYOUT.LANE_GROUP_PAD,
      y: y - 18,
      width: maxX - minX + LAYOUT.LANE_GROUP_PAD * 2,
      height: LAYOUT.LANE_GROUP_HEIGHT,
      stepIds: members.map((n) => n.id)
    });
  }

  const maxX = nodes.length
    ? Math.max(...nodes.map((n) => n.x + LAYOUT.NODE_WIDTH), LAYOUT.CENTER_X + LAYOUT.NODE_WIDTH)
    : LAYOUT.CENTER_X + LAYOUT.NODE_WIDTH;
  const maxY = nodes.length
    ? Math.max(...nodes.map((n) => n.y + LAYOUT.NODE_HEIGHT), LAYOUT.TOP_PADDING + LAYOUT.NODE_HEIGHT)
    : LAYOUT.TOP_PADDING + LAYOUT.NODE_HEIGHT;

  return {
    nodes,
    edges,
    laneGroups,
    bounds: { width: maxX + LAYOUT.LANE_WIDTH, height: maxY + LAYOUT.ROW_HEIGHT },
    content: contentExtent(nodes, laneGroups)
  };
}

/** Horizontal extent of the placed nodes and their lane groups, with no outer
 *  padding. Falls back to the center spine when there is nothing to render. */
function contentExtent(
  nodes: LayoutNode[],
  laneGroups: LaneGroup[]
): { minX: number; maxX: number } {
  if (!nodes.length) {
    return { minX: 0, maxX: LAYOUT.CENTER_X + LAYOUT.NODE_WIDTH };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x + LAYOUT.NODE_WIDTH);
  }
  for (const group of laneGroups) {
    minX = Math.min(minX, group.x);
    maxX = Math.max(maxX, group.x + group.width);
  }
  return { minX, maxX };
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