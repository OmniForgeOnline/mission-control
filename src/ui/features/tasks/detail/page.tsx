import { render } from "preact";
import { $ } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { findTask, ui } from "@ui/app/state.js";
import { navigateBack } from "@ui/app/router.js";
import { toast } from "@ui/overlays/toast.js";
import { bindTails } from "@ui/features/runs/tail.js";
import { openArtifactViewer } from "@ui/overlays/slideover.js";
import { executeTaskAction } from "@ui/shared/components/task-actions.js";
import { TaskTicketHeader } from "./header.js";
import { WorkflowPane } from "./workflow/index.js";
import type { HarnessTask } from "@ui/app/types.js";

let mountedTaskId: string | null = null;
let selectedStepId: string | null = null;
let activePanelTab: "overview" | "step" | "activity" = "step";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function NotFoundView() {
  return (
    <div class="view">
      <button class="btn btn-ghost detail-back" id="backBtn" onClick={() => navigateBack()}>
        <Icon name="arrow-left" size={14} />
        <span>Back</span>
      </button>
      <div class="empty-state">
        <h3>Task not found</h3>
      </div>
    </div>
  );
}

function TaskDetailShell({ task }: { task: HarnessTask }) {
  return (
    <div class="view" id="taskDetailView">
      <div class="detail-ticket" id="taskDetailLayout">
        <TaskTicketHeader task={task} />
        <div class="detail-ticket-body">
          <WorkflowPane
            task={task}
            selectedStepId={selectedStepId}
            onSelectStep={(stepId) => {
              selectedStepId = stepId;
              renderTaskDetail();
            }}
            activeTab={activePanelTab}
            onTabChange={(tab) => {
              activePanelTab = tab;
              renderTaskDetail();
            }}
          />
        </div>
      </div>
    </div>
  );
}

function bindTaskDetailShell(): void {
  const layout = $("#taskDetailLayout");
  if (!layout || layout.dataset["bound"]) return;
  layout.dataset["bound"] = "true";

  layout.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const task = findTask(ui.taskId);
    if (!task) return;

    const actionBtn = target.closest<HTMLElement>("[data-detail-action]");
    if (actionBtn) {
      await executeTaskAction(task, actionBtn.dataset["detailAction"]!);
      return;
    }

    const chip = target.closest<HTMLElement>(".chip-mono");
    if (chip?.dataset["copy"]) {
      navigator.clipboard
        .writeText(chip.dataset["copy"])
        .then(() => toast(`Copied ${chip.dataset["copy"]}`));
      return;
    }

    const runItem = target.closest<HTMLElement>(".run-item");
    if (runItem?.dataset["runId"]) {
      const file = runItem.dataset["runFile"] ?? "summary.md";
      void openArtifactViewer(`/api/runs/${runItem.dataset["runId"]}/artifacts/${file}`, file);
    }
  });
}

function renderNotFound(): void {
  mountedTaskId = null;
  selectedStepId = null;
  const root = $("#viewContent");
  if (!root) return;
  render(<NotFoundView />, root);
}

function renderTaskDetailShell(task: HarnessTask): void {
  const root = $("#viewContent");
  if (!root) return;
  render(<TaskDetailShell task={task} />, root);
  bindTaskDetailShell();
  const view = $("#taskDetailView");
  if (view) bindTails(view);
}

export function updateTaskActivityView(): void {
  const task = findTask(ui.taskId);
  if (!task || mountedTaskId !== task.id) return;
  renderTaskDetailShell(task);
}

export function updateTaskDetailView(): void {
  const task = findTask(ui.taskId);
  if (!task) {
    renderNotFound();
    return;
  }
  if (mountedTaskId !== task.id || !$("#taskDetailView")) {
    renderTaskDetail();
    return;
  }
  renderTaskDetailShell(task);
}

export function renderTaskDetail(): void {
  const task = findTask(ui.taskId);
  if (!task) {
    renderNotFound();
    return;
  }

  if (mountedTaskId !== task.id) {
    selectedStepId = task.workflowRun?.currentStepId ?? null;
    activePanelTab = "step";
    mountedTaskId = task.id;
  }

  renderTaskDetailShell(task);
}
