import { WorkflowCanvas } from "./canvas.js";
import { WorkflowActivityPanel } from "./panel/activity.js";
import { WorkflowOverviewPanel } from "./panel/overview.js";
import { WorkflowStepPanel } from "./panel/step.js";
import { WorkflowSplitPane } from "./split-pane.js";
import { workflowForTask } from "@ui/app/state.js";
import type { HarnessTask } from "@ui/app/types.js";

export type WorkflowPanelTab = "overview" | "step" | "activity";

export interface WorkflowPaneProps {
  task: HarnessTask;
  selectedStepId: string | null;
  onSelectStep: (stepId: string | null) => void;
  activeTab: WorkflowPanelTab;
  onTabChange: (tab: WorkflowPanelTab) => void;
}

export function WorkflowPane({
  task,
  selectedStepId,
  onSelectStep,
  activeTab,
  onTabChange
}: WorkflowPaneProps) {
  const workflow = workflowForTask(task);
  const tab = activeTab;
  const setTab = onTabChange;

  if (!workflow || !task.workflowRun) {
    return (
      <div class="wf-empty">
        <p>No workflow run is attached to this task.</p>
      </div>
    );
  }

  function handleSelect(stepId: string): void {
    onSelectStep(stepId);
    setTab("step");
  }

  return (
    <div class="wf-shell">
      <div class="wf-legend">
        <span>
          <span class="wf-legend-swatch done" /> Completed
        </span>
        <span>
          <span class="wf-legend-swatch current" /> Current
        </span>
        <span>
          <span class="wf-legend-swatch upcoming" /> Upcoming
        </span>
        <span>
          <span class="wf-legend-bar operator" /> Operator-gated
        </span>
        <span>
          <span class="wf-legend-bar daemon" /> Auto (daemon)
        </span>
        <span class="faint">drag to pan · scroll to zoom · drag splitter to resize panel</span>
      </div>

      <WorkflowSplitPane
        canvas={
          <WorkflowCanvas
            task={task}
            workflow={workflow}
            selectedStepId={selectedStepId}
            onSelectStep={handleSelect}
          />
        }
        panel={
          <>
            <div class="wf-tabs">
              {(["overview", "step", "activity"] as const).map((name) => (
                <button
                  key={name}
                  type="button"
                  class={`wf-tab${tab === name ? " active" : ""}`}
                  onClick={() => setTab(name)}
                >
                  {name === "overview" ? "Overview" : name === "step" ? "Step" : "Activity"}
                </button>
              ))}
            </div>
            <div class="wf-panel-scroll">
              {tab === "overview" ? <WorkflowOverviewPanel task={task} /> : null}
              {tab === "step" ? (
                <WorkflowStepPanel task={task} workflow={workflow} stepId={selectedStepId} />
              ) : null}
              {tab === "activity" ? <WorkflowActivityPanel task={task} /> : null}
            </div>
          </>
        }
      />
    </div>
  );
}

