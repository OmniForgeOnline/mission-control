import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { liveness, relativeTime, workflowForTask } from "@ui/app/state.js";
import { taskExecution, taskIsRunning, taskPmStatus } from "@ui/app/task-status.js";
import { currentStepIndex } from "@ui/app/workflow-steps.js";
import { navigateBack } from "@ui/app/router.js";
import { requestRefresh } from "@ui/data/refresh.js";
import { icon } from "@ui/shell/icons.js";
import { toast } from "@ui/overlays/toast.js";
import { DetailPrimaryActionButton, getPrimaryAction } from "@ui/shared/components/task-actions.js";
import { WorktreeHandoffMenu } from "./worktree-handoff.js";
import type { HarnessTask, PmStatus } from "@ui/app/types.js";

function pmStatusLabel(status: PmStatus): string {
  switch (status) {
    case "backlog":
      return "Backlog";
    case "in_progress":
      return "In Progress";
    case "in_review":
      return "In Review";
    case "done":
      return "Done";
    default:
      return status;
  }
}

function pmStatusSwatch(status: PmStatus): string {
  switch (status) {
    case "backlog":
      return "sw-backlog";
    case "in_progress":
      return "sw-progress";
    case "in_review":
      return "sw-review";
    case "done":
      return "sw-done";
    default:
      return "sw-progress";
  }
}

function execLabel(task: HarnessTask): string {
  const execution = taskExecution(task);
  const run = task.workflowRun;
  const parallel = run?.activeStepIds?.length ?? (run ? 1 : 0);
  if (execution === "running" && parallel > 1) {
    return `Running · ${parallel} parallel jobs`;
  }
  if (execution === "running") return "Running";
  if (execution === "blocked") return "Blocked";
  if (execution === "paused") return "Paused";
  return "Idle";
}

function resolutionText(task: HarnessTask): string | null {
  if (!task.resolution) return null;
  return task.resolution.replace(/_/g, " ");
}

const OPERATOR_ACTIONS: Array<{ value: "backlog" | "cancelled"; label: string; hint: string }> = [
  { value: "backlog", label: "Move to Backlog", hint: "Park this ticket — the pipeline won't move it back" },
  { value: "cancelled", label: "Cancel ticket", hint: "Abandon as won't-fix / duplicate" }
];

export function TaskTicketHeader({ task }: { task: HarnessTask }) {
  const workflow = workflowForTask(task);
  const workflowDef = workflowForTask(task);
  const derivedPm = workflowDef ? taskPmStatus(task) : "in_progress";
  const override = task.statusOverride?.value;
  const effective = derivedPm;
  const statusNote = override
    ? "Status set manually by operator (override)"
    : "Status auto-derived from workflow · click to override";

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const primaryAction = getPrimaryAction(task);
  const live = liveness(task);
  const run = task.workflowRun;
  const stepNumber = workflow && run ? currentStepIndex(workflow, run.currentStepId) : 0;
  const totalSteps = workflow?.stepIds.length ?? 0;
  const stageLabel = run?.currentStepId.replace(/_/g, " ") ?? "—";
  const timingNote =
    taskIsRunning(task) && task.startedAt
      ? ` · ${live?.text ?? `running ${relativeTime(task.startedAt)}`}`
      : "";

  useEffect(() => {
    function onDocClick(event: MouseEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  async function runOperatorAction(value: "backlog" | "cancelled"): Promise<void> {
    try {
      if (value === "cancelled") {
        await api(`/api/tasks/${task.id}/cancel`, { method: "POST" });
      } else {
        await api(`/api/tasks/${task.id}/pm-status`, {
          method: "POST",
          body: JSON.stringify({ value })
        });
      }
      requestRefresh();
    } catch (err) {
      toast((err as Error).message);
    }
  }

  return (
    <div class="ticket-head" id="taskDetailHeader">
      <div class="ticket-head-top">
        <button class="btn btn-ghost detail-back" id="backBtn" type="button" onClick={() => navigateBack()}>
          <span dangerouslySetInnerHTML={{ __html: icon("arrow-left", 14) }} />
          <span>Back</span>
        </button>
        <div>
          <div class="ticket-title">{task.title}</div>
          <span class="ticket-id">
            {task.id.slice(0, 8).toUpperCase()} · {workflow?.name ?? "workflow"}
          </span>
        </div>
        <div class="ticket-head-actions">
          <div class="statuswrap" ref={menuRef}>
            <span class="status-badge" title={statusNote}>
              <span class={`swatch ${pmStatusSwatch(effective)}`} />
              <span class="lbl">{pmStatusLabel(effective)}</span>
              <span class="status-src">{override ? "operator" : "auto"}</span>
            </span>
            <button
              class="status-ovf"
              type="button"
              aria-label="Operator actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              ⋯
            </button>
            <div class={`status-menu${menuOpen ? " open" : ""}`} role="menu">
              <div class="status-menu-title">Operator actions</div>
              {OPERATOR_ACTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  class="status-opt"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void runOperatorAction(opt.value);
                  }}
                >
                  <span class={`swatch ${opt.value === "cancelled" ? "sw-cancel" : "sw-backlog"}`} />
                  <span class="status-opt-body">
                    <span class="status-opt-label">{opt.label}</span>
                    <small>{opt.hint}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <span class="exec-badge" data-exec={taskExecution(task)}>
            <span class="dot" />
            {execLabel(task)}
          </span>

          {resolutionText(task) ? (
            <span class="resolution-pill">Resolution · {resolutionText(task)}</span>
          ) : null}

          {run ? (
            <span class="ticket-stage">
              Stage {stepNumber} of {totalSteps} · {stageLabel}
              {timingNote}
            </span>
          ) : null}

          {primaryAction ? <DetailPrimaryActionButton spec={primaryAction} /> : null}

          <WorktreeHandoffMenu task={task} />
        </div>
      </div>
    </div>
  );
}