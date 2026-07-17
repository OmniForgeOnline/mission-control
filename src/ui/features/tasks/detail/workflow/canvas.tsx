import { useEffect, useRef, useState } from "preact/hooks";
import { computeBranchEdgeGeometry, computeEdgeGeometry } from "./edges.js";
import {
  CONTAIN_FIT,
  DEFAULT_TRANSFORM,
  PANEL_FIT,
  clampZoom,
  computeFitTransform,
  type FitTransform
} from "./fit.js";
import { layoutFromWorkflowSummary } from "./layout.js";
import { WorkflowNode } from "./node.js";
import { decorateLayoutEdges } from "./state.js";
import { stepShowsAutoAdvanceNote } from "@ui/app/workflow-steps.js";
import { icon } from "@ui/shell/icons.js";
import type { HarnessTask, WorkflowSummary } from "@ui/app/types.js";

export interface WorkflowCanvasProps {
  task: HarnessTask;
  workflow: WorkflowSummary;
  selectedStepId: string | null;
  onSelectStep: (stepId: string) => void;
  /** "panel" (default) keeps nodes readable and pins to the top for the
   *  scrollable ticket sidebar; "contain" fits the whole graph and centers it
   *  for the wide workflow editor canvas. */
  fitMode?: "panel" | "contain";
}

type Transform = FitTransform;

export function WorkflowCanvas({
  task,
  workflow,
  selectedStepId,
  onSelectStep,
  fitMode = "panel"
}: WorkflowCanvasProps) {
  const fitConfig = fitMode === "contain" ? CONTAIN_FIT : PANEL_FIT;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>(DEFAULT_TRANSFORM);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  const layout = layoutFromWorkflowSummary(workflow);
  const decorated = decorateLayoutEdges(layout.edges, task, workflow);
  const geometry = computeEdgeGeometry(layout.nodes, decorated).map((geom) => {
    const meta = decorated.find(
      (edge) => edge.from === geom.from && edge.to === geom.to && edge.kind === geom.kind
    );
    return { ...geom, done: meta?.done, active: meta?.active, branch: meta?.branch ?? geom.branch };
  });
  const branchGeometry = computeBranchEdgeGeometry(layout.nodes, decorated);
  const autoNoteStep = task.workflowRun?.currentStepId;
  const showAutoNote =
    autoNoteStep && stepShowsAutoAdvanceNote(task, workflow, autoNoteStep);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      setTransform(
        computeFitTransform(
          el.clientWidth,
          el.clientHeight,
          layout.bounds,
          layout.content,
          fitConfig
        )
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [
    task.id,
    workflow.id,
    layout.bounds.width,
    layout.bounds.height,
    layout.content.minX,
    layout.content.maxX,
    layout.content.minY,
    layout.content.maxY,
    fitConfig
  ]);

  useEffect(() => {
    function onMouseMove(event: MouseEvent): void {
      if (!dragging) return;
      setTransform((current) => ({
        ...current,
        x: dragStart.current.tx + (event.clientX - dragStart.current.x),
        y: dragStart.current.ty + (event.clientY - dragStart.current.y)
      }));
    }

    function onMouseUp(): void {
      setDragging(false);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging]);

  function zoomBy(factor: number): void {
    setTransform((current) => ({ ...current, scale: clampZoom(current.scale * factor) }));
  }

  return (
    <div
      ref={wrapRef}
      class={`wf-canvas-wrap${dragging ? " is-grabbing" : ""}`}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest(".wf-node, .wf-canvas-toolbar button")) return;
        setDragging(true);
        dragStart.current = {
          x: event.clientX,
          y: event.clientY,
          tx: transform.x,
          ty: transform.y
        };
      }}
      onWheel={(event) => {
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        const magnitude = Math.min(Math.abs(event.deltaY), 200);
        const factor = 1 + direction * magnitude * 0.003;
        zoomBy(factor);
      }}
    >
      {showAutoNote ? (
        <div class="wf-auto-note">
          <span class="dot" />
          <span
            dangerouslySetInnerHTML={{
              __html: `${icon("zap", 12)} Advancing automatically — no action needed`
            }}
          />
        </div>
      ) : null}

      <div class="wf-canvas-toolbar">
        <button class="wf-ctl" type="button" title="Zoom in" onClick={() => zoomBy(1.15)}>
          +
        </button>
        <button class="wf-ctl" type="button" title="Zoom out" onClick={() => zoomBy(0.87)}>
          −
        </button>
        <button
          class="wf-ctl"
          type="button"
          title="Fit"
          onClick={() => {
            const el = wrapRef.current;
            if (!el) {
              setTransform(DEFAULT_TRANSFORM);
              return;
            }
            setTransform(
              computeFitTransform(
                el.clientWidth,
                el.clientHeight,
                layout.bounds,
                layout.content,
                fitConfig
              )
            );
          }}
        >
          ⊡
        </button>
      </div>

      <div
        class="wf-plane"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
        }}
      >
        {layout.laneGroups.map((group) => (
          <div
            key={group.id}
            class="wf-lane-group"
            style={{
              left: `${group.x}px`,
              top: `${group.y}px`,
              width: `${group.width}px`,
              height: `${group.height}px`
            }}
          >
            <span class="wf-lane-tag">parallel · {group.label}</span>
          </div>
        ))}

        {geometry
          .filter((edge) => !edge.branch)
          .map((edge) => (
            <div
              key={`${edge.from}-${edge.to}-${edge.kind}`}
              class={[
                "wf-edge",
                edge.done ? "done" : "",
                edge.active ? "active" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: `${edge.x1}px`,
                top: `${edge.y1}px`,
                width: `${edge.length}px`,
                transform: `rotate(${edge.angleDeg}deg)`
              }}
            />
          ))}

        {branchGeometry.length > 0 ? (
          <svg
            class="wf-branch-layer"
            width={layout.bounds.width}
            height={layout.bounds.height}
            viewBox={`0 0 ${layout.bounds.width} ${layout.bounds.height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="wf-rework-arrow"
                markerWidth="11"
                markerHeight="11"
                refX="8"
                refY="5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path class="wf-branch-arrow" d="M1 1 L9 5 L1 9 Z" />
              </marker>
            </defs>
            {branchGeometry.map((edge) => (
              <g key={`branch-${edge.from}-${edge.to}`}>
                <path
                  class="wf-branch-path"
                  d={edge.path}
                  marker-end="url(#wf-rework-arrow)"
                />
                <g
                  class="wf-branch-label"
                  transform={`translate(${edge.labelX}, ${edge.labelY})`}
                >
                  <rect x="-30" y="-10" width="60" height="20" rx="10" />
                  <text x="0" y="1" text-anchor="middle" dominant-baseline="middle">
                    rework
                  </text>
                </g>
              </g>
            ))}
          </svg>
        ) : null}

        {layout.nodes.map((node) => (
          <WorkflowNode
            key={node.id}
            task={task}
            workflow={workflow}
            stepId={node.id}
            x={node.x}
            y={node.y}
            selected={selectedStepId === node.id}
            onSelect={onSelectStep}
          />
        ))}
      </div>

    </div>
  );
}
