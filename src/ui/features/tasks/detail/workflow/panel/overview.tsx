import { effectiveTaskEffort, relativeTime, workflowForTask } from "@ui/app/state.js";
import { renderMarkdown } from "@ui/shared/lib/markdown.js";
import { BlockedRecovery } from "../../blocked-recovery.js";
import { RepoBindingRecovery } from "../../repo-binding-recovery.js";
import type { HarnessTask } from "@ui/app/types.js";

function resolutionLabel(task: HarnessTask): string {
  if (!task.resolution) return "— (open)";
  return task.resolution.replace(/_/g, " ");
}

function repoName(task: HarnessTask): string {
  if (!task.repoPath) return "—";
  return task.repoPath.split("/").filter(Boolean).pop() ?? task.repoPath;
}

export function WorkflowOverviewPanel({ task }: { task: HarnessTask }) {
  const workflow = workflowForTask(task);
  const targets = task.targets?.map((t) => t.path).join(", ") || "—";
  const description = task.description?.trim() ?? "";
  const effort = effectiveTaskEffort(task);

  const currentStepId = task.workflowRun?.currentStepId;
  const currentStep = currentStepId ? workflow?.steps[currentStepId] : undefined;
  const currentStepLabel = currentStepId ? currentStepId.replace(/_/g, " ") : null;
  const currentStepApproved = currentStepId
    ? task.workflowRun?.stepApprovals?.[currentStepId]?.status === "approved"
    : false;
  const needsApproval = currentStep?.approval === "required" && !currentStepApproved;
  let stateHint = "";
  if (currentStepId) {
    if (needsApproval || task.blockedReason) stateHint = "awaiting approval";
    else if (currentStep?.kind === "review") stateHint = "in review";
  }

  return (
    <div class="wf-pane">
      <div class="wf-sec-title">Details</div>
      <div class="wf-details">
        <div class="wf-detail">
          <span class="k">Workflow</span>
          <span class="v">{workflow?.name ?? task.workflowRun?.workflowId ?? "—"}</span>
        </div>
        {currentStepLabel ? (
          <div class="wf-detail">
            <span class="k">Current step</span>
            <span class="v">
              {currentStepLabel}
              {stateHint ? <span class="muted"> · {stateHint}</span> : null}
            </span>
          </div>
        ) : null}
        <div class="wf-detail">
          <span class="k">Created</span>
          <span class="v">{relativeTime(task.createdAt)}</span>
        </div>
        <div class="wf-detail">
          <span class="k">Targets</span>
          <span class="v mono">{targets}</span>
        </div>
        <div class="wf-detail">
          <span class="k">Resolution</span>
          <span class="v faint">{resolutionLabel(task)}</span>
        </div>
        <div class="wf-detail">
          <span class="k">Repository</span>
          <span class="v">
            {repoName(task)}
            {task.repoPath ? <span class="v-sub mono">{task.repoPath}</span> : null}
          </span>
        </div>
        <div class="wf-detail">
          <span class="k">Branch</span>
          <span class="v mono">{task.branch ?? "—"}</span>
        </div>
        <div class="wf-detail">
          <span class="k">Effort</span>
          <span class="v">{effort ?? "—"}</span>
        </div>
      </div>

      <div class="wf-spacer" />

      <div class="wf-sec-title">Description</div>
      {description ? (
        <div
          class="wf-desc message-body"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(description, "description") }}
        />
      ) : (
        <p class="wf-desc muted">No description yet.</p>
      )}

      <RepoBindingRecovery task={task} />
      <BlockedRecovery task={task} />
    </div>
  );
}