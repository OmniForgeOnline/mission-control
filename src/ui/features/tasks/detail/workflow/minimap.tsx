import { LAYOUT } from "./layout.js";
import { nodeVisualState, type NodeVisualState } from "./state.js";
import type { HarnessTask, WorkflowSummary } from "@ui/app/types.js";
import type { WorkflowLayout } from "./layout.js";

const MINIMAP_WIDTH = 110;
const MINIMAP_HEIGHT = 150;

export interface MinimapProps {
  task: HarnessTask;
  workflow: WorkflowSummary;
  layout: WorkflowLayout;
  viewport: {
    width: number;
    height: number;
    translateX: number;
    translateY: number;
    scale: number;
  };
}

function minimapNodeClass(state: NodeVisualState): string {
  if (state === "done") return "done";
  if (state === "running" || state === "current") return "current";
  return "";
}

export function WorkflowMinimap({ task, workflow, layout, viewport }: MinimapProps) {
  const sx = MINIMAP_WIDTH / layout.bounds.width;
  const sy = MINIMAP_HEIGHT / layout.bounds.height;

  const viewWidth = Math.min(MINIMAP_WIDTH - 2, (viewport.width / viewport.scale) * sx);
  const viewHeight = Math.min(MINIMAP_HEIGHT - 2, (viewport.height / viewport.scale) * sy);
  const viewLeft = Math.max(0, (-viewport.translateX / viewport.scale) * sx);
  const viewTop = Math.max(0, (-viewport.translateY / viewport.scale) * sy);

  return (
    <div class="wf-minimap" aria-hidden="true">
      {layout.nodes.map((node) => {
        const state = nodeVisualState(node.id, task, workflow);
        return (
          <div
            key={node.id}
            class={`wf-mm-node ${minimapNodeClass(state)}`}
            style={{
              left: `${node.x * sx}px`,
              top: `${node.y * sy}px`,
              width: `${Math.max(8, LAYOUT.NODE_WIDTH * sx)}px`,
              height: "7px"
            }}
          />
        );
      })}
      <div
        class="wf-mm-view"
        style={{
          left: `${viewLeft}px`,
          top: `${viewTop}px`,
          width: `${viewWidth}px`,
          height: `${viewHeight}px`
        }}
      />
    </div>
  );
}