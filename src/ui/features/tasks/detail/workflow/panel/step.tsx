import { api } from "@ui/data/api.js";
import { useState } from "preact/hooks";
import { requestRefresh } from "@ui/data/refresh.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { confirm } from "@ui/overlays/confirm.js";
import { taskIsRunning } from "@ui/app/task-status.js";
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
import { StepChat } from "./step-chat.js";
import { StepSettingMenu, type StepSettingOption } from "./step-setting-menu.js";
import { agentVisual, effortBarSpec, type AgentVisual } from "./step-setting-visual.js";
import { AgentLogo, isKnownAgentLogo } from "./agent-logo.js";
import { WorkflowEmptyState } from "./empty-state.js";
import { MergeRequestChip } from "@ui/shared/components/task-chips.js";
import { AttachmentChips } from "@ui/shared/components/attachments.js";
import { TerminalPane } from "@ui/shared/components/terminal-pane.js";
import type { AgentSummary, HarnessTask, WorkflowSummary } from "@ui/app/types.js";

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

type NodeAction = "approve" | "rollback";

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

async function completeInteractiveTurn(
  taskId: string,
  outcome: "done" | "blocked",
  note: string
): Promise<void> {
  await api(`/api/tasks/${taskId}/interactive/complete`, {
    method: "POST",
    body: JSON.stringify({
      outcome,
      ...(note.trim() ? { note: note.trim() } : {})
    })
  });
  toast(outcome === "done" ? "Step marked done" : "Step blocked", { tone: "success" });
  requestRefresh();
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

async function setStepModel(taskId: string, stepId: string, poolId: string): Promise<void> {
  try {
    if (poolId) {
      await api(`/api/tasks/${taskId}/stage-model-pools/${encodeURIComponent(stepId)}`, {
        method: "POST",
        body: JSON.stringify({ poolId })
      });
      toast("Model pinned for this step", { tone: "success" });
    } else {
      await api(`/api/tasks/${taskId}/stage-model-pools/${encodeURIComponent(stepId)}`, {
        method: "DELETE"
      });
      toast("Using default model for this step", { tone: "success" });
    }
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
  const [completeBusy, setCompleteBusy] = useState(false);

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

  const capacityNote = stepAgentCapacityNote(task, stepId);
  const defaultAgent = workflowStepAgent(task, stepId);
  const agents = ui.data?.agents ?? [];
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

  const isRunning = taskIsRunning(task);
  const approved = task.workflowRun?.stepApprovals[stepId]?.status === "approved";
  const needsApproval = step.approval === "required" && !approved;
  const isActive = isStepActive(task, stepId);
  const canRollback = Boolean(task.workflowRun?.completedSteps.includes(stepId));
  // Model recorded on the run that executed this step (completed or active);
  // falls back to the live run only for the step currently in flight.
  const stepModel = modelPoolDisplayName(stepRunModelPoolId(task, stepId));
  // An earlier, completed, non-terminal step can be reopened with a fresh message.
  const canRevertStep = !isActive
    && step.kind !== "terminal"
    && Boolean(task.workflowRun?.completedSteps.includes(stepId));
  // Specific models (those that pin a --model). The no-arg "default" pool is
  // excluded — it is what "" (Default) resolves to, so listing it would duplicate.
  const stepModelPools = (ui.data?.agentConfig?.pools ?? []).filter(
    (p) => p.toolId === effectiveAgentId && p.enabled && p.modelArgs.length > 0
  );
  const selectedModelPool = task.stageModelPoolOverrides?.[stepId] ?? "";
  const chosenPool = stepModelPools.find((p) => p.id === selectedModelPool);
  const modelTriggerLabel = chosenPool?.displayName ?? stepModel ?? "default";
  const modelOptions: StepSettingOption[] = [
    {
      value: "",
      label: "Default",
      leading: settingSwatch({ color: "var(--ink-faint)", initial: "·" }),
      meta: stepModel ?? undefined
    },
    ...stepModelPools.map((p) => ({
      value: p.id,
      label: p.displayName,
      leading: settingSwatch({
        color: "var(--ink-faint)",
        initial: (p.displayName[0] ?? "·").toUpperCase()
      })
    }))
  ];
  const showModelMenu = hasAgent && (stepModelPools.length > 0 || Boolean(selectedModelPool));
  const interactiveStep = hasAgent && (step.kind === "agent_turn" || step.kind === "conversation");
  const interactiveSessionId = (ui.data?.interactiveSessions ?? []).find((s) => s.taskId === task.id)
    ?.terminalSessionId;
  const showInteractiveComplete = interactiveStep && (Boolean(interactiveSessionId) || (isActive && isRunning));
  const showSettingsActions = needsApproval || canRollback || showInteractiveComplete;

  async function onInteractiveComplete(outcome: "done" | "blocked"): Promise<void> {
    if (completeBusy) return;
    setCompleteBusy(true);
    try {
      await completeInteractiveTurn(task.id, outcome, "");
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setCompleteBusy(false);
    }
  }

  return (
    <div class={`wf-pane${interactiveStep ? " is-terminal" : ""}`}>
      <div class="wf-details">
        <div class="wf-detail wide wf-settings-line">
          <div class="wf-settings-core" role="group" aria-label="Agent settings">
            <div class="wf-setting-cell">
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
            {showModelMenu || stepModel ? (
              <div class="wf-setting-cell">
                <span class="k">Model</span>
                <span class="v">
                  {showModelMenu ? (
                    <StepSettingMenu
                      label="Model for this step"
                      heading="Model for this step"
                      options={modelOptions}
                      selected={selectedModelPool}
                      triggerLeading={settingSwatch({ color: "var(--ink-faint)", initial: "·" })}
                      triggerLabel={modelTriggerLabel}
                      onSelect={(value) => void setStepModel(task.id, stepId, value)}
                    />
                  ) : (
                    <span class="mono">{stepModel}</span>
                  )}
                </span>
              </div>
            ) : null}
            {showEffort ? (
              <div class="wf-setting-cell">
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
          </div>
          {showSettingsActions ? (
            <div class="wf-settings-actions">
              {needsApproval ? (
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  onClick={() => void runNodeAction(task.id, stepId, "approve")}
                >
                  Approve step
                </button>
              ) : null}
              {showInteractiveComplete ? (
                <>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    disabled={completeBusy || !interactiveSessionId}
                    onClick={() => void onInteractiveComplete("done")}
                  >
                    Done
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-danger"
                    disabled={completeBusy || !interactiveSessionId}
                    onClick={() => void onInteractiveComplete("blocked")}
                  >
                    Block
                  </button>
                </>
              ) : null}
              {canRollback ? (
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
          ) : null}
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
      </div>

      {interactiveStep ? (
        <TerminalPane
          {...(interactiveSessionId ? { sessionId: interactiveSessionId } : {})}
          active={isActive && isRunning}
        />
      ) : (
        <StepChat task={task} stepId={stepId} canRevert={canRevertStep} />
      )}
    </div>
  );
}
