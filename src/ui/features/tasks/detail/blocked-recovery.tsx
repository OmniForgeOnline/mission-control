import { useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { defaultHarnessAgent, resolvedStepAgent, ui } from "@ui/app/state.js";
import { uiLegacyStatus } from "@ui/app/task-status.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { requestRefresh } from "@ui/data/refresh.js";
import { icon } from "@ui/shell/icons.js";
import { formatBlockedReason } from "./blocked-reason.js";
import type { HarnessTask } from "@ui/app/types.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

export function BlockedRecovery({ task }: { task: HarnessTask }) {
  const formatted = formatBlockedReason(task.blockedReason ?? "");
  const currentAgent = resolvedStepAgent(task) ?? defaultHarnessAgent();
  const agents = ui.data?.agents ?? [];
  const alternatives = agents.filter((agent) => agent.id !== currentAgent);
  const stepId = task.workflowRun?.currentStepId;
  const [retryAgent, setRetryAgent] = useState(alternatives[0]?.id ?? "");

  if (uiLegacyStatus(task) !== "blocked" || !formatted.recoverable || !stepId || alternatives.length === 0) {
    return null;
  }

  async function handleRetry(): Promise<void> {
    if (!retryAgent || !stepId) return;
    try {
      await api(`/api/tasks/${task.id}/stage-agents/${encodeURIComponent(stepId)}`, {
        method: "POST",
        body: JSON.stringify({ agent: retryAgent })
      });
      await api(`/api/tasks/${task.id}/resume`, { method: "POST" });
      toast(`Resumed ${stepId} with ${retryAgent}.`, { tone: "success" });
      requestRefresh();
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  return (
    <section class="wf-blocked-recovery">
      <div class="wf-sec-title">Recovery</div>
      <p class="wf-desc muted">
        Retry this step with a different agent, then resume the task.
      </p>
      <div class="wf-step-actions">
        <select
          class="select"
          value={retryAgent}
          onChange={(e) => setRetryAgent((e.currentTarget as HTMLSelectElement).value)}
        >
          {alternatives.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.displayName}
            </option>
          ))}
        </select>
        <button class="btn btn-sm btn-primary" type="button" onClick={() => void handleRetry()}>
          <Icon name="rotate-ccw" size={12} />
          <span>Retry with agent</span>
        </button>
      </div>
    </section>
  );
}
