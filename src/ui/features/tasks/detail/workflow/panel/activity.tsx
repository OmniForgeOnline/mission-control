import { useEffect, useState } from "preact/hooks";
import { activeRunModelPoolId, liveness, modelPoolDisplayName, relativeTime, ui } from "@ui/app/state.js";
import { taskIsRunning } from "@ui/app/task-status.js";
import { subscribeRunEventStream } from "@ui/data/run-events.js";
import { icon } from "@ui/shell/icons.js";
import { WorkflowEmptyState } from "./empty-state.js";
import { appendRunActivityEntry, type RunActivityEntry } from "@harness/core/runs/activity.ts";
import { capabilityTier, capabilityTierLabel } from "@harness/core/agents/config/capabilities.ts";
import type { RunEvent } from "@harness/core/runs/events.ts";
import type { HarnessTask } from "@ui/app/types.js";

/** Resolve the live-capability tier for a task's current agent. */
function agentTier(task: HarnessTask): "live" | "stream" | "batch" {
  const tool = ui.data?.agentConfig?.tools.find((entry) => entry.id === task.agent);
  if (!tool) return "batch";
  return capabilityTier(tool.cli);
}

function CapabilityBadge({ task }: { task: HarnessTask }) {
  const tier = agentTier(task);
  return (
    <span class={`wf-cap-badge is-${tier}`} title="Agent live-interaction capability">
      {capabilityTierLabel(tier)}
    </span>
  );
}

function activitySummary(entry: RunActivityEntry): string | null {
  const text = entry.text ?? entry.detail;
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > 110 ? `${collapsed.slice(0, 110)}...` : collapsed;
}

function charCount(text: string | undefined): string {
  const count = text?.length ?? 0;
  if (count < 1000) return `${count} chars`;
  return `${(count / 1000).toFixed(1)}k chars`;
}

/** Compact HH:MM stamp pinned to the right of each row; empty for bad dates. */
function activityTime(at: string | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Fixed-width rail glyph per activity kind so every row aligns on the timeline. */
function activityGlyph(kind: RunActivityEntry["kind"]): string {
  switch (kind) {
    case "action":
      return "terminal";
    case "thinking":
      return "brain";
    case "message":
      return "bot";
    case "operator":
      return "user";
    case "error":
      return "alert-triangle";
    case "status":
      return "check";
    default:
      return "activity";
  }
}

function RunActivityRow({ entry }: { entry: RunActivityEntry }) {
  const body = entry.text ?? entry.detail;
  const summary = activitySummary(entry);
  const time = activityTime(entry.at);

  return (
    <details class={`wf-activity-row is-${entry.kind}`}>
      <summary>
        <span class="wf-activity-glyph" dangerouslySetInnerHTML={{ __html: icon(activityGlyph(entry.kind), 12) }} />
        <span class="wf-activity-head">
          <span class="wf-activity-chevron" dangerouslySetInnerHTML={{ __html: icon("chevron-right", 11) }} />
          <span class="wf-activity-title">{entry.title}</span>
          {entry.kind === "thinking" ? <span class="wf-activity-count">{charCount(entry.text)}</span> : null}
          {summary ? <span class="wf-activity-summary">{summary}</span> : null}
        </span>
        {time ? <span class="wf-activity-time">{time}</span> : null}
      </summary>
      {body ? <pre class="wf-activity-body">{body}</pre> : null}
    </details>
  );
}

function RunActivityFeed({ runId }: { runId: string }) {
  const [entries, setEntries] = useState<RunActivityEntry[]>([]);

  useEffect(() => {
    setEntries([]);
    let frame = 0;
    let pending: RunEvent[] = [];
    const flush = (): void => {
      frame = 0;
      const batch = pending;
      pending = [];
      setEntries((prev) => batch.reduce<RunActivityEntry[]>(appendRunActivityEntry, prev));
    };
    const unsubscribe = subscribeRunEventStream(runId, 0, (event) => {
      pending.push(event);
      if (!frame) {
        frame = requestAnimationFrame(flush);
      }
    });
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      pending = [];
    };
  }, [runId]);

  if (entries.length === 0) return null;

  return (
    <>
      <div class="wf-rail-label">Stream</div>
      <div class="wf-activity-feed">
        {entries.map((entry) => (
          <RunActivityRow entry={entry} key={entry.id} />
        ))}
      </div>
    </>
  );
}

function timelineEntries(task: HarnessTask): Array<{ title: string; at?: string }> {
  const entries: Array<{ title: string; at?: string }> = [];

  if (task.approvedAt) {
    entries.push({ title: "Plan approved", at: task.approvedAt });
  }
  if (task.pushedAt) {
    entries.push({ title: "Changes pushed", at: task.pushedAt });
  }
  if (task.completedAt) {
    entries.push({ title: "Workflow completed", at: task.completedAt });
  }
  if (task.resolution) {
    entries.push({
      title: `Resolution · ${task.resolution.replace(/_/g, " ")}`,
      at: task.updatedAt
    });
  }
  if (task.reviewState && task.reviewRounds && task.reviewRounds > 0) {
    entries.push({
      title: `Reviewer: ${task.reviewState.replace(/_/g, " ")}`,
      at: task.lastProgressAt ?? task.updatedAt
    });
  }

  const run = task.workflowRun;
  if (run) {
    if (run.activeStepIds && run.activeStepIds.length > 1) {
      entries.push({
        title: `Parallel jobs running · ${run.activeStepIds.map((id) => id.replace(/_/g, " ")).join(", ")}`,
        at: task.lastProgressAt ?? task.updatedAt
      });
    }
    for (const stepId of run.completedSteps) {
      entries.push({
        title: `${stepId.replace(/_/g, " ")} completed`,
        at: run.stepApprovals[stepId]?.approvedAt ?? task.updatedAt
      });
    }
  }

  return entries
    .sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""))
    .slice(0, 12);
}

/** Live-run header card — only while a run is actively streaming. */
function LiveTailSection({ task }: { task: HarnessTask }) {
  const runId = task.runId;
  const running = taskIsRunning(task) && Boolean(runId);
  const live = liveness(task);
  const model = modelPoolDisplayName(activeRunModelPoolId(task));

  if (!running || !runId) return null;

  return (
    <section class="wf-live-tail">
      <div class="wf-live-head">
        <div class="wf-live-main">
          <div class="wf-live-title">
            Live run <CapabilityBadge task={task} />
            {model ? <span class="wf-live-model muted"> · {model}</span> : null}
          </div>
          {live ? (
            <p class={`wf-live-meta${live.warn ? " warn" : ""}`}>
              <span dangerouslySetInnerHTML={{ __html: icon("activity", 12) }} />
              {live.text}
              {task.currentActivity ? ` · ${task.currentActivity}` : ""}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function WorkflowActivityPanel({ task }: { task: HarnessTask }) {
  const entries = timelineEntries(task);
  const runId = task.runId;
  const running = taskIsRunning(task) && Boolean(runId);

  // Nothing ran and no durable milestones yet: a single clear empty state
  // reads better than an empty "Timeline" heading over a muted line.
  if (!running && !runId && entries.length === 0) {
    return (
      <div class="wf-pane wf-activity-pane">
        <WorkflowEmptyState
          icon="activity"
          title="No workflow events yet"
          body="Run the task to start a turn. Actions, thinking, and status stream here."
        />
      </div>
    );
  }

  return (
    <div class="wf-pane wf-activity-pane">
      <LiveTailSection task={task} />

      {/* Stream persists after the run completes so operators can review what
          the agent did; the live-run header above only shows while running. */}
      {runId ? <RunActivityFeed runId={runId} /> : null}

      <div class="wf-rail-label">Timeline</div>
      {entries.length === 0 ? (
        <p class="wf-desc muted">No milestones recorded yet.</p>
      ) : (
        <div class="wf-milestones">
          {entries.map((entry) => (
            <div class="wf-milestone" key={`${entry.title}-${entry.at}`}>
              <span class="wf-milestone-dot" aria-hidden="true" />
              <span class="wf-milestone-title">{entry.title}</span>
              <span class="wf-milestone-time">{relativeTime(entry.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
