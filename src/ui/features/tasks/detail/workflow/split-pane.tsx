import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { icon } from "@ui/shell/icons.js";
import {
  clampWorkflowPanelHeight,
  defaultWorkflowPanelHeight,
  getWorkflowPanelCollapsed,
  getWorkflowPanelHeight,
  hasStoredWorkflowPanelHeight,
  MAX_WORKFLOW_PANEL_HEIGHT,
  MIN_WORKFLOW_PANEL_HEIGHT,
  panelHeightFromPointer,
  setWorkflowPanelCollapsed,
  setWorkflowPanelHeight,
  WORKFLOW_SPLITTER_HEIGHT
} from "./panel-size.js";

export interface WorkflowSplitPaneProps {
  canvas: ComponentChildren;
  panel: ComponentChildren;
}

function Icon({ name, size = 14 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

/**
 * Vertical split: workflow canvas on top, details/terminal panel on the bottom.
 * Collapse hides the upper workflow so the details/terminal fill the view.
 */
export function WorkflowSplitPane({ canvas, panel }: WorkflowSplitPaneProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(getWorkflowPanelHeight());
  const [collapsed, setCollapsed] = useState(getWorkflowPanelCollapsed());
  const [resizing, setResizing] = useState(false);

  // First visit: short workflow strip. If the user has dragged before, restore
  // that height (clamped so they can still grow/shrink within limits).
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const height = body.clientHeight;
    if (height <= 0) return;
    const preferred = hasStoredWorkflowPanelHeight()
      ? getWorkflowPanelHeight()
      : defaultWorkflowPanelHeight(height);
    const next = clampWorkflowPanelHeight(preferred, height);
    setWorkflowPanelHeight(next);
    setPanelHeight(next);
  }, []);

  useEffect(() => {
    if (!resizing || collapsed) return;

    function onPointerMove(event: PointerEvent): void {
      const body = bodyRef.current;
      if (!body) return;
      const next = panelHeightFromPointer(event.clientY, body.getBoundingClientRect());
      setWorkflowPanelHeight(next);
      setPanelHeight(next);
    }

    function onPointerUp(): void {
      setResizing(false);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [resizing, collapsed]);

  function toggleCollapsed(): void {
    const next = !collapsed;
    setWorkflowPanelCollapsed(next);
    setCollapsed(next);
  }

  return (
    <div
      ref={bodyRef}
      class={`wf-body${resizing ? " is-resizing" : ""}${collapsed ? " is-collapsed" : ""}`}
      style={
        collapsed
          ? undefined
          : ({ "--wf-panel-height": `${panelHeight}px` } as Record<string, string>)
      }
    >
      {collapsed ? (
        <div class="wf-canvas-collapsed">
          <button
            type="button"
            class="wf-panel-expand"
            aria-expanded={false}
            aria-label="Show workflow canvas"
            title="Show workflow"
            onClick={toggleCollapsed}
          >
            <Icon name="chevron-down" size={16} />
            <span>Workflow</span>
          </button>
        </div>
      ) : (
        canvas
      )}

      {collapsed ? null : (
        <div
          class="wf-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={panelHeight}
          aria-valuemin={MIN_WORKFLOW_PANEL_HEIGHT}
          aria-valuemax={MAX_WORKFLOW_PANEL_HEIGHT}
          tabIndex={0}
          style={{ height: `${WORKFLOW_SPLITTER_HEIGHT}px` }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            if ((event.target as HTMLElement).closest(".wf-panel-collapse")) return;
            event.preventDefault();
            try {
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            } catch {
              /* capture optional — window listeners still track the drag */
            }
            setResizing(true);
          }}
          onKeyDown={(event) => {
            const body = bodyRef.current;
            if (!body) return;
            const step = event.shiftKey ? 48 : 16;
            if (event.key === "ArrowUp") {
              event.preventDefault();
              const next = clampWorkflowPanelHeight(panelHeight + step, body.clientHeight);
              setWorkflowPanelHeight(next);
              setPanelHeight(next);
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              const next = clampWorkflowPanelHeight(panelHeight - step, body.clientHeight);
              setWorkflowPanelHeight(next);
              setPanelHeight(next);
            }
          }}
        >
          <button
            type="button"
            class="wf-panel-collapse"
            aria-expanded={true}
            aria-label="Hide workflow canvas"
            title="Hide workflow — expand details"
            onClick={(event) => {
              event.stopPropagation();
              toggleCollapsed();
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="chevron-up" size={16} />
          </button>
        </div>
      )}

      <aside class="wf-panel" aria-label="Workflow details">
        <div class="wf-panel-body">{panel}</div>
      </aside>
    </div>
  );
}
