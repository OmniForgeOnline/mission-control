import { api } from "@ui/data/api.js";
import { canApprovePlan } from "../../../core/prompts/plan-approval.ts";
import { canRefinePlan, isPreImplementationReview } from "../../../core/prompts/plan-refinement.ts";
import { icon } from "@ui/shell/icons.js";
import { workflowForTask } from "@ui/app/state.js";
import { uiLegacyStatus } from "@ui/app/task-status.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { requestRefresh } from "@ui/data/refresh.js";
import type { HarnessTask, WorkflowSummary } from "@ui/app/types.js";
export type TaskActionKind =
  | "stop"
  | "resume"
  | "approve-plan"
  | "approve"
  | "run"
  | "requeue"
  | "cancel"
  | "delete"
  | "open";

export interface PrimaryActionSpec {
  action: TaskActionKind;
  label: string;
  icon: string;
  tone: "primary" | "danger" | "default";
  title?: string;
}

function stepNeedsApproval(
  workflow: WorkflowSummary,
  run: NonNullable<HarnessTask["workflowRun"]>
): boolean {
  const step = workflow.steps[run.currentStepId];
  if (!step) return false;
  const approved = run.stepApprovals?.[run.currentStepId]?.status === "approved";
  return step.approval === "required" && !approved;
}

function currentStepNeedsApproval(task: HarnessTask): boolean {
  const run = task.workflowRun;
  const workflow = workflowForTask(task);
  if (!run || !workflow) return uiLegacyStatus(task) === "queued";
  return stepNeedsApproval(workflow, run);
}

export function planReadyForApproval(task: HarnessTask): boolean {
  const workflow = workflowForTask(task);
  if (!workflow) return false;
  return canApprovePlan(task, workflow);
}

export function planRefinementReady(task: HarnessTask): boolean {
  const workflow = workflowForTask(task);
  if (!workflow) return false;
  return canRefinePlan(task, workflow);
}

export function getPrimaryAction(task: HarnessTask): PrimaryActionSpec | null {
  const status = uiLegacyStatus(task);
  if (status === "running") {
    return { action: "stop", label: "Stop", icon: "square", tone: "danger", title: "Stop" };
  }
  if (status === "paused" || status === "interrupted") {
    return { action: "resume", label: "Resume", icon: "play", tone: "primary", title: "Resume" };
  }
  if (status === "blocked") {
    return { action: "resume", label: "Resume step", icon: "play", tone: "primary", title: "Resume step" };
  }
  if (planReadyForApproval(task)) {
    return {
      action: "approve-plan",
      label: "Approve & run",
      icon: "check",
      tone: "primary"
    };
  }
  if (currentStepNeedsApproval(task)) {
    const workflow = workflowForTask(task);
    const label =
      workflow && isPreImplementationReview(task, workflow)
        ? "Start implementation"
        : "Approve step";
    return { action: "approve", label, icon: "check", tone: "primary" };
  }
  if (status === "queued") {
    const autoApproves = !planRefinementReady(task);
    return {
      action: "run",
      label: autoApproves ? "Approve & run" : "Run",
      icon: "play",
      tone: "primary",
      title: autoApproves ? "Approve & run" : "Run"
    };
  }
  if (status === "approved") {
    return { action: "run", label: "Run", icon: "play", tone: "primary", title: "Run" };
  }
  if (status === "awaiting_operator" || status === "awaiting_review") {
    if (planReadyForApproval(task)) return null;
    return {
      action: "run",
      label: "Run another turn",
      icon: "play",
      tone: "primary",
      title: "Run"
    };
  }
  if (["completed", "cancelled"].includes(status)) {
    return {
      action: "requeue",
      label: "Requeue",
      icon: "rotate-ccw",
      tone: "default",
      title: "Requeue"
    };
  }
  return null;
}

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

export function PrimaryActionButton({
  spec,
  taskId,
  onClick
}: {
  spec: PrimaryActionSpec;
  taskId: string;
  onClick?: (event: Event) => void;
}) {
  const btnClass =
    spec.action === "stop"
      ? "btn btn-sm btn-danger row-primary-action"
      : "btn btn-sm btn-ghost row-primary-action";

  return (
    <button
      class={btnClass}
      title={spec.title ?? spec.label}
      data-row-action={spec.action}
      data-id={taskId}
      onClick={onClick}
    >
      <Icon name={spec.icon} size={14} />
      <span class="row-action-label">{spec.label}</span>
    </button>
  );
}

export function DetailPrimaryActionButton({ spec }: { spec: PrimaryActionSpec }) {
  const btnClass =
    spec.tone === "danger"
      ? "btn btn-danger"
      : spec.tone === "primary"
        ? "btn btn-primary"
        : "btn";

  return (
    <button class={btnClass} data-detail-action={spec.action}>
      <Icon name={spec.icon} size={14} />
      <span>{spec.label}</span>
    </button>
  );
}

export async function executeTaskAction(
  task: HarnessTask,
  action: string,
  options?: {
    onNavigate?: (taskId: string) => void;
    refresh?: boolean;
    approvePlanMessage?: string;
    requeueMessage?: string;
    resumeMessage?: string;
    deleteMessage?: string;
  }
): Promise<void> {
  const refresh = options?.refresh !== false;
  const id = task.id;

  try {
    if (action === "approve") {
      await api(`/api/tasks/${id}/approve`, { method: "POST" });
      if (refresh) requestRefresh();
      return;
    }
    if (action === "approve-plan") {
      await api(`/api/tasks/${id}/approve-plan`, { method: "POST" });
      toast(
        options?.approvePlanMessage ?? "Approved — running through to merge request.",
        { tone: "success" }
      );
      if (refresh) requestRefresh();
      return;
    }
    if (action === "run") {
      if (uiLegacyStatus(task) === "queued" && !planRefinementReady(task)) {
        await api(`/api/tasks/${id}/approve`, { method: "POST" });
      }
      await api(`/api/tasks/${id}/turn`, { method: "POST" });
      options?.onNavigate?.(id);
      if (refresh) requestRefresh();
      return;
    }
    if (action === "cancel") {
      await api(`/api/tasks/${id}/cancel`, { method: "POST" });
      if (refresh) requestRefresh();
      return;
    }
    if (action === "stop" && task.runId) {
      await api(`/api/runs/${task.runId}/kill`, { method: "POST" });
      if (refresh) requestRefresh();
      return;
    }
    if (action === "resume") {
      await api(`/api/tasks/${id}/resume`, { method: "POST" });
      if (options?.resumeMessage) toast(options.resumeMessage);
      options?.onNavigate?.(id);
      if (refresh) requestRefresh();
      return;
    }
    if (action === "requeue") {
      await api(`/api/tasks/${id}/requeue`, { method: "POST" });
      if (options?.requeueMessage) toast(options.requeueMessage);
      if (refresh) requestRefresh();
      return;
    }
    if (action === "delete") {
      await api(`/api/tasks/${id}`, { method: "DELETE" });
      if (options?.deleteMessage) toast(options.deleteMessage);
      if (refresh) requestRefresh();
      return;
    }
    if (action === "open") {
      options?.onNavigate?.(id);
    }
  } catch (err) {
    errorToast((err as Error).message);
  }
}
