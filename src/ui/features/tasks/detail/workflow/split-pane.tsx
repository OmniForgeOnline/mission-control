import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  clampWorkflowPanelWidth,
  defaultWorkflowPanelWidth,
  getWorkflowPanelWidth,
  hasStoredWorkflowPanelWidth,
  MAX_WORKFLOW_PANEL_WIDTH,
  MIN_WORKFLOW_PANEL_WIDTH,
  panelWidthFromPointer,
  setWorkflowPanelWidth,
  WORKFLOW_SPLITTER_WIDTH
} from "./panel-size.js";

export interface WorkflowSplitPaneProps {
  canvas: ComponentChildren;
  panel: ComponentChildren;
}

export function WorkflowSplitPane({ canvas, panel }: WorkflowSplitPaneProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(getWorkflowPanelWidth());
  const [resizing, setResizing] = useState(false);

  // Apply the 60/40 default from the measured body width on first mount,
  // unless the operator has already dragged the splitter (persisted choice).
  useEffect(() => {
    if (hasStoredWorkflowPanelWidth()) return;
    const body = bodyRef.current;
    if (!body) return;
    const width = body.clientWidth;
    if (width <= 0) return;
    setPanelWidth(defaultWorkflowPanelWidth(width));
  }, []);

  useEffect(() => {
    if (!resizing) return;

    function onMouseMove(event: MouseEvent): void {
      const body = bodyRef.current;
      if (!body) return;
      const next = panelWidthFromPointer(event.clientX, body.getBoundingClientRect());
      setWorkflowPanelWidth(next);
      setPanelWidth(next);
    }

    function onMouseUp(): void {
      setResizing(false);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [resizing]);

  return (
    <div
      ref={bodyRef}
      class={`wf-body${resizing ? " is-resizing" : ""}`}
      style={{ "--wf-panel-width": `${panelWidth}px` } as Record<string, string>}
    >
      {canvas}

      <div
        class="wf-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={panelWidth}
        aria-valuemin={MIN_WORKFLOW_PANEL_WIDTH}
        aria-valuemax={MAX_WORKFLOW_PANEL_WIDTH}
        tabIndex={0}
        style={{ width: `${WORKFLOW_SPLITTER_WIDTH}px` }}
        onMouseDown={(event) => {
          event.preventDefault();
          setResizing(true);
        }}
        onKeyDown={(event) => {
          const body = bodyRef.current;
          if (!body) return;
          const step = event.shiftKey ? 48 : 16;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            const next = clampWorkflowPanelWidth(panelWidth + step, body.clientWidth);
            setWorkflowPanelWidth(next);
            setPanelWidth(next);
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            const next = clampWorkflowPanelWidth(panelWidth - step, body.clientWidth);
            setWorkflowPanelWidth(next);
            setPanelWidth(next);
          }
        }}
      />

      <aside class="wf-panel">{panel}</aside>
    </div>
  );
}