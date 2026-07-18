import { useEffect, useRef, useState } from "preact/hooks";
import { computeBranchEdgeGeometry, computeEdgeGeometry } from "./edges.js";
import {
  CONTAIN_FIT,
  DEFAULT_TRANSFORM,
  clampZoom,
  computeFitTransform,
  panelFitForViewport,
  zoomToward,
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

type Point = { x: number; y: number };

function pointerDistance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pointerMidpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function WorkflowCanvas({
  task,
  workflow,
  selectedStepId,
  onSelectStep,
  fitMode = "panel"
}: WorkflowCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>(DEFAULT_TRANSFORM);
  const [dragging, setDragging] = useState(false);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const layout = layoutFromWorkflowSummary(workflow);
  const decorated = decorateLayoutEdges(layout.edges, task, workflow);
  const geometry = computeEdgeGeometry(layout.nodes, decorated).map((geom) => {
    const meta = decorated.find(
      (edge) => edge.from === geom.from && edge.to === geom.to && edge.kind === geom.kind
    );
    return { ...geom, done: meta?.done, active: meta?.active, branch: meta?.branch ?? geom.branch };
  });
  const branchGeometry = computeBranchEdgeGeometry(layout.nodes, decorated);
  const forwardGeometry = geometry.filter((edge) => !edge.branch);
  const maxBranchBow = branchGeometry.reduce((max, edge) => Math.max(max, edge.bowY), 0);
  const edgeLayerW = layout.bounds.width;
  const edgeLayerH = Math.max(layout.bounds.height, maxBranchBow > 0 ? maxBranchBow + 18 : 0);
  const autoNoteStep = task.workflowRun?.currentStepId;
  const showAutoNote =
    autoNoteStep && stepShowsAutoAdvanceNote(task, workflow, autoNoteStep);

  function activeFitConfig(viewportWidth: number) {
    return fitMode === "contain" ? CONTAIN_FIT : panelFitForViewport(viewportWidth);
  }

  function fitToViewport(): void {
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
        activeFitConfig(el.clientWidth)
      )
    );
  }

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
          activeFitConfig(el.clientWidth)
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
    fitMode
  ]);

  // Pan (1 pointer) + pinch-zoom (2 pointers). Pointer Events cover mouse + touch.
  useEffect(() => {
    const maybe = wrapRef.current;
    if (!maybe) return;
    const surface: HTMLElement = maybe;

    const pointers = new Map<number, Point>();
    let pan: { origin: Point; tx: number; ty: number } | null = null;
    let pinch: {
      distance: number;
      scale: number;
      mid: Point;
      tx: number;
      ty: number;
    } | null = null;

    function beginPinch(): void {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const t = transformRef.current;
      pan = null;
      setDragging(false);
      pinch = {
        distance: Math.max(1, pointerDistance(a, b)),
        scale: t.scale,
        mid: pointerMidpoint(a, b),
        tx: t.x,
        ty: t.y
      };
    }

    function onPointerDown(event: PointerEvent): void {
      if ((event.target as HTMLElement).closest(".wf-node, .wf-canvas-toolbar button")) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try {
        surface.setPointerCapture(event.pointerId);
      } catch {
        /* optional */
      }
      event.preventDefault();

      if (pointers.size >= 2) {
        beginPinch();
        return;
      }

      const t = transformRef.current;
      pan = { origin: { x: event.clientX, y: event.clientY }, tx: t.x, ty: t.y };
      setDragging(true);
    }

    function onPointerMove(event: PointerEvent): void {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        if (!a || !b) return;
        const dist = Math.max(1, pointerDistance(a, b));
        const mid = pointerMidpoint(a, b);
        const rect = surface.getBoundingClientRect();
        const nextScale = clampZoom(pinch.scale * (dist / pinch.distance));
        const zoomed = zoomToward(
          { x: pinch.tx, y: pinch.ty, scale: pinch.scale },
          rect.left,
          rect.top,
          pinch.mid.x,
          pinch.mid.y,
          nextScale
        );
        setTransform({
          ...zoomed,
          x: zoomed.x + (mid.x - pinch.mid.x),
          y: zoomed.y + (mid.y - pinch.mid.y)
        });
        return;
      }

      if (pan && pointers.size === 1) {
        setTransform({
          ...transformRef.current,
          x: pan.tx + (event.clientX - pan.origin.x),
          y: pan.ty + (event.clientY - pan.origin.y)
        });
      }
    }

    function onPointerUp(event: PointerEvent): void {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      try {
        surface.releasePointerCapture(event.pointerId);
      } catch {
        /* optional */
      }

      if (pointers.size < 2) pinch = null;

      if (pointers.size === 0) {
        pan = null;
        setDragging(false);
        return;
      }

      if (pointers.size === 1) {
        const remaining = [...pointers.values()][0]!;
        const t = transformRef.current;
        pan = { origin: remaining, tx: t.x, ty: t.y };
        setDragging(true);
      }
    }

    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerUp);
    return () => {
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  function zoomBy(factor: number): void {
    setTransform((current) => ({ ...current, scale: clampZoom(current.scale * factor) }));
  }

  return (
    <div
      ref={wrapRef}
      class={`wf-canvas-wrap${dragging ? " is-grabbing" : ""}`}
      onWheel={(event) => {
        event.preventDefault();
        const el = wrapRef.current;
        if (!el) {
          zoomBy(event.deltaY < 0 ? 1.15 : 0.87);
          return;
        }
        const direction = event.deltaY < 0 ? 1 : -1;
        const magnitude = Math.min(Math.abs(event.deltaY), 200);
        const factor = 1 + direction * magnitude * 0.003;
        const rect = el.getBoundingClientRect();
        setTransform((current) =>
          zoomToward(
            current,
            rect.left,
            rect.top,
            event.clientX,
            event.clientY,
            current.scale * factor
          )
        );
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
        <button class="wf-ctl" type="button" title="Fit" onClick={() => fitToViewport()}>
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

        {forwardGeometry.length > 0 || branchGeometry.length > 0 ? (
          <svg
            class="wf-edge-layer"
            width={edgeLayerW}
            height={edgeLayerH}
            viewBox={`0 0 ${edgeLayerW} ${edgeLayerH}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="wf-edge-arrow"
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path class="wf-edge-arrow" d="M1.5 1.2 L8.5 5 L1.5 8.8 Z" />
              </marker>
              <marker
                id="wf-rework-arrow"
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path class="wf-branch-arrow" d="M1.5 1.2 L8.5 5 L1.5 8.8 Z" />
              </marker>
            </defs>
            {forwardGeometry.map((edge) => (
              <path
                key={`${edge.from}-${edge.to}-${edge.kind}`}
                class={[
                  "wf-edge-path",
                  edge.done ? "is-done" : "",
                  edge.active ? "is-active" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                d={edge.path}
                marker-end="url(#wf-edge-arrow)"
              />
            ))}
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
                  <rect x="-28" y="-9" width="56" height="18" rx="2" />
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
