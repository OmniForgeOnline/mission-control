import { api } from "@ui/data/api.js";
import { useState } from "preact/hooks";
import { requestRefresh } from "@ui/data/refresh.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { confirm } from "@ui/overlays/confirm.js";
import { taskIsRunning } from "@ui/app/task-status.js";
import {
  isDaemonDrivenStep,
  isOperatorGatedStep
} from "@ui/app/workflow-steps.js";
import {
  effectiveTaskEffort,
  isStepActive,
  modelPoolDisplayName,
  resolvedStepAgent,
  stepAgentCapacityNote,
  stepRunModelPoolId,
  ui,
  workflowStepAgent
} from "@ui/app/state.js";
import {
  nodeStateLabel,
  nodeVisualState,
  parallelPosition
} from "../state.js";
import { StepChat } from "./step-chat.js";
import { StepSettingMenu, type StepSettingOption } from "./step-setting-menu.js";
import { agentVisual, effortBarSpec, type AgentVisual } from "./step-setting-visual.js";
import { AgentLogo, isKnownAgentLogo } from "./agent-logo.js";
import { WorkflowEmptyState } from "./empty-state.js";
import { MergeRequestChip } from "@ui/shared/components/task-chips.js";
import { AttachmentChips } from "@ui/shared/components/attachments.js";
import type { AgentSummary, HarnessTask, ProjectSummary, WorkflowSummary } from "@ui/app/types.js";

function settingSwatch(visual: AgentVisual) {
  return (
    <span class="wf-setting-swatch" style={{ background: visual.color }}>
      {visual.initial}
    </span>
  );
}

function agentLeading(id: string | null | undefined, displayName?: string) {
  if (isKnownAgentLogo(id)) {
    return <AgentLogo id={id} title={displayName ?? id} />;
  }
  return settingSwatch(agentVisual(id, displayName));
}

function settingBars(levels: readonly string[], current: string) {
  return (
    <span class="wf-setting-bars" aria-hidden="true">
      {effortBarSpec(levels, current).map((bar, i) => (
        <i key={i} class={bar.on ? "on" : ""} style={{ height: `${bar.height}px` }} />
      ))}
    </span>
  );
}

function stepLabel(stepId: string): string {
  return stepId.replace(/_/g, " ");
}

type NodeAction = "approve" | "rollback" | "skip";

async function runNodeAction(taskId: string, stepId: string, action: NodeAction): Promise<void> {
  try {
    await api(`/api/tasks/${taskId}/workflow-step`, {
      method: "POST",
      body: JSON.stringify({ stepId, action })
    });
    toast(`Step ${action} applied`, { tone: "success" });
    requestRefresh();
  } catch (err) {
    errorToast((err as Error).message);
  }
}

async function setStepAgent(taskId: string, stepId: string, agent: string): Promise<void> {
  try {
    if (agent) {
      await api(`/api/tasks/${taskId}/stage-agents/${encodeURIComponent(stepId)}`, {
        method: "POST",
        body: JSON.stringify({ agent })
      });
      toast(`Agent set to ${agent} for this step`, { tone: "success" });
    } else {
      await api(`/api/tasks/${taskId}/stage-agents/${encodeURIComponent(stepId)}`, {
        method: "DELETE"
      });
      toast("Using workflow default agent for this step", { tone: "success" });
    }
    requestRefresh();
  } catch (err) {
    errorToast((err as Error).message);
  }
}

async function setStepEffort(taskId: string, stepId: string, effort: string): Promise<void> {
  try {
    if (effort) {
      await api(`/api/tasks/${taskId}/stage-effort/${encodeURIComponent(stepId)}`, {
        method: "POST",
        body: JSON.stringify({ effort })
      });
      toast(`Effort set to ${effort} for this step`, { tone: "success" });
    } else {
      await api(`/api/tasks/${taskId}/stage-effort/${encodeURIComponent(stepId)}`, {
        method: "DELETE"
      });
      toast("Using default effort for this step", { tone: "success" });
    }
    requestRefresh();
  } catch (err) {
    errorToast((err as Error).message);
  }
}

function targetName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function projectTarget(task: HarnessTask): { name: string; path: string; empty: boolean } {
  const target = task.targets?.[0];
  if (!target) {
    return { name: "No project selected", path: "Add a project path before the next run.", empty: true };
  }
  return { name: targetName(target.path), path: target.path, empty: false };
}

function projectOptionLabel(project: ProjectSummary): string {
  return `${project.name} — ${project.repoPath}`;
}

async function bindProject(taskId: string, path: string): Promise<void> {
  try {
    await api(`/api/tasks/${taskId}/bind-repo`, {
      method: "POST",
      body: JSON.stringify({ path })
    });
    toast("Project updated", { tone: "success" });
    requestRefresh();
  } catch (err) {
    errorToast((err as Error).message);
  }
}

export function WorkflowStepPanel({
  task,
  workflow,
  stepId
}: {
  task: HarnessTask;
  workflow: WorkflowSummary;
  stepId: string | null;
}) {
  if (!stepId) {
    return (
      <div class="wf-pane">
        <WorkflowEmptyState
          icon="search"
          title="No step selected"
          body="Select a step on the canvas to see its agent, settings, and conversation."
        />
      </div>
    );
  }

  const step = workflow.steps[stepId];
  if (!step) {
    return (
      <div class="wf-pane">
        <WorkflowEmptyState
          icon="alert-triangle"
          title="Unknown step"
          body="This step is not part of the current workflow definition."
        />
      </div>
    );
  }

  const state = nodeVisualState(stepId, task, workflow);
  const capacityNote = stepAgentCapacityNote(task, stepId);
  const defaultAgent = workflowStepAgent(task, stepId);
  const agents = ui.data?.agents ?? [];
  const projects = ui.data?.projects ?? [];
  const agentById = (id: string): AgentSummary | undefined => agents.find((a) => a.id === id);
  const selectedAgent = task.stageAgentOverrides?.[stepId] ?? "";
  const hasAgent = step.agent !== "none";
  const effectiveAgentId = resolvedStepAgent(task, stepId) ?? "";
  const effectiveAgent = agentById(effectiveAgentId);
  const agentTriggerLabel = effectiveAgent?.displayName ?? (effectiveAgentId || "—");
  const agentOptions: StepSettingOption[] = [
    {
      value: "",
      label: "Workflow default",
      leading: settingSwatch({ color: "var(--ink-faint)", initial: "·" }),
      meta: defaultAgent ? (agentById(defaultAgent)?.displayName ?? defaultAgent) : undefined
    },
    ...agents.map((a) => ({
      value: a.id,
      label: a.displayName,
      leading: agentLeading(a.id, a.displayName)
    }))
  ];

  const effortLevels = effectiveAgent?.effortLevels ?? [];
  const showEffort = hasAgent && Boolean(effectiveAgent?.supportsEffort) && effortLevels.length > 0;
  const selectedEffort = task.stageEffortOverrides?.[stepId] ?? "";
  const effectiveEffort = effectiveTaskEffort(task, stepId) ?? "";
  const effortOptions: StepSettingOption[] = [
    {
      value: "",
      label: "Task default",
      leading: settingBars(effortLevels, effectiveEffort),
      meta: effectiveEffort || undefined
    },
    ...effortLevels.map((level) => ({
      value: level,
      label: level,
      leading: settingBars(effortLevels, level)
    }))
  ];

  const project = projectTarget(task);
  const isRunning = taskIsRunning(task);
  const [editingProject, setEditingProject] = useState(project.empty);
  const [projectPath, setProjectPath] = useState(project.empty ? "" : project.path);
  const approved = task.workflowRun?.stepApprovals[stepId]?.status === "approved";
  const parallel = parallelPosition(stepId, workflow);
  const advancement = isOperatorGatedStep(workflow, stepId)
    ? "Operator approval required"
    : isDaemonDrivenStep(workflow, stepId)
      ? "Daemon advances automatically"
      : "Standard";
  const needsApproval = step.approval === "required" && !approved;
  const isActive = isStepActive(task, stepId);
  // Model recorded on the run that executed this step (completed or active);
  // falls back to the live run only for the step currently in flight.
  const stepModel = modelPoolDisplayName(stepRunModelPoolId(task, stepId));
  // An earlier, completed, non-terminal step can be reopened with a fresh message.
  const canRevertStep = !isActive
    && step.kind !== "terminal"
    && Boolean(task.workflowRun?.completedSteps.includes(stepId));

  return (
    <div class="wf-pane">
      <div class="wf-step-head">
        <span class={`wf-node-dot is-${state}`} aria-hidden="true" />
        <h3>{stepLabel(stepId)}</h3>
        <span class="wf-node-state">{nodeStateLabel(state)}</span>
      </div>

      <div class="wf-details">
        <div class="wf-detail">
          <span class="k">Agent</span>
          <span class="v">
            {hasAgent ? (
              <StepSettingMenu
                label="Agent for this step"
                heading="Agent for this step"
                options={agentOptions}
                selected={selectedAgent}
                triggerLeading={agentLeading(effectiveAgentId, effectiveAgent?.displayName)}
                triggerLabel={agentTriggerLabel}
                onSelect={(value) => void setStepAgent(task.id, stepId, value)}
              />
            ) : (
              <span class="mono">—</span>
            )}
            {capacityNote ? <span class="muted wf-agent-capacity">{capacityNote}</span> : null}
          </span>
        </div>
        {stepModel ? (
          <div class="wf-detail">
            <span class="k">Model</span>
            <span class="v mono">{stepModel}</span>
          </div>
        ) : null}
        {showEffort ? (
          <div class="wf-detail">
            <span class="k">Effort</span>
            <span class="v">
              <StepSettingMenu
                label="Reasoning effort for this step"
                heading="Reasoning effort"
                options={effortOptions}
                selected={selectedEffort}
                triggerLeading={settingBars(effortLevels, effectiveEffort)}
                triggerLabel={effectiveEffort || "default"}
                onSelect={(value) => void setStepEffort(task.id, stepId, value)}
              />
            </span>
          </div>
        ) : null}
        <div class="wf-detail wide">
          <span class="k">Project</span>
          <span class="v project-target">
            {editingProject ? (
              <div class="project-target-editor">
                <select
                  class="select project-target-select"
                  value={projectPath}
                  disabled={isRunning || projects.length === 0}
                  aria-label="Project"
                  onChange={(e) => setProjectPath((e.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="" disabled>
                    {projects.length ? "Select a project" : "No projects available"}
                  </option>
                  {projects.map((candidate) => (
                    <option key={candidate.id} value={candidate.repoPath}>
                      {projectOptionLabel(candidate)}
                    </option>
                  ))}
                </select>
                <span class="project-target-actions">
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    disabled={!projectPath.trim() || isRunning}
                    onClick={() => void bindProject(task.id, projectPath.trim())}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm"
                    onClick={() => {
                      setProjectPath(project.empty ? "" : project.path);
                      setEditingProject(false);
                    }}
                  >
                    Cancel
                  </button>
                </span>
              </div>
            ) : (
              <>
                <span class={project.empty ? "muted" : ""}>{project.name}</span>
                <span class="muted mono project-target-path">{project.path}</span>
                <button
                  type="button"
                  class="btn btn-sm"
                  disabled={isRunning}
                  onClick={() => setEditingProject(true)}
                >
                  Change project
                </button>
              </>
            )}
            {isRunning ? (
              <span class="muted wf-agent-effective">Stop the running task before changing project.</span>
            ) : null}
          </span>
        </div>
        {task.mergeRequest ? (
          <div class="wf-detail wide">
            <span class="k">Merge request</span>
            <span class="v">
              <MergeRequestChip mergeRequest={task.mergeRequest} />
            </span>
          </div>
        ) : null}
        {task.attachments?.length ? (
          <div class="wf-detail wide">
            <span class="k">Attachments</span>
            <span class="v">
              <AttachmentChips attachments={task.attachments} />
            </span>
          </div>
        ) : null}
        <div class="wf-detail">
          <span class="k">Kind</span>
          <span class="v">{step.kind}</span>
        </div>
        <div class="wf-detail">
          <span class="k">Approval</span>
          <span class="v">
            {step.approval === "required" ? (approved ? "approved" : "required") : "none"}
          </span>
        </div>
        <div class="wf-detail">
          <span class="k">Advancement</span>
          <span class="v">{advancement}</span>
        </div>
        <div class="wf-detail">
          <span class="k">Parallel</span>
          <span class="v">
            {parallel
              ? `job ${parallel.index} of ${parallel.total} in "${parallel.groupId.replace(/_/g, " ")}"`
              : "—"}
          </span>
        </div>
      </div>

      <div class="wf-step-actions">
        {needsApproval ? (
          <button
            type="button"
            class="btn btn-sm btn-primary"
            onClick={() => void runNodeAction(task.id, stepId, "approve")}
          >
            Approve step
          </button>
        ) : null}
        {isActive && step.kind !== "terminal" ? (
          <button
            type="button"
            class="btn btn-sm"
            onClick={() => void runNodeAction(task.id, stepId, "skip")}
          >
            Skip
          </button>
        ) : null}
        {task.workflowRun?.completedSteps.includes(stepId) ? (
          <button
            type="button"
            class="btn btn-sm btn-danger"
            onClick={() => {
              void confirm({
                title: "Rollback to this step?",
                message: "Downstream progress will be trimmed.",
                confirmLabel: "Rollback",
                tone: "danger"
              }).then((ok) => {
                if (ok) void runNodeAction(task.id, stepId, "rollback");
              });
            }}
          >
            Rollback
          </button>
        ) : null}
      </div>

      <StepChat task={task} stepId={stepId} canRevert={canRevertStep} />
    </div>
  );
}
