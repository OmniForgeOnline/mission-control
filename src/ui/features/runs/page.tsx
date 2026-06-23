import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { icon } from "@ui/shell/icons.js";
import { groupRunsByTask, type RunTaskGroup } from "@ui/features/runs/groups.js";
import { ui, relativeTime, modelPoolDisplayName } from "@ui/app/state.js";
import { navigate } from "@ui/app/router.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { confirm } from "@ui/overlays/confirm.js";
import { bindTails } from "@ui/features/runs/tail.js";
import { openArtifactViewer } from "@ui/overlays/slideover.js";
import { StatusBadge } from "@ui/shared/components/task-chips.js";
import type { HarnessRun } from "@ui/app/types.js";

const expandedGroups = new Map<string, boolean>();

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function isGroupExpanded(taskId: string, defaultExpanded: boolean): boolean {
  return expandedGroups.has(taskId) ? expandedGroups.get(taskId)! : defaultExpanded;
}

function TailHost({ id }: { id: string }) {
  return <div class="tail-host" data-tail-host={id} />;
}

function RunItem({ run }: { run: HarnessRun }) {
  const summaryArtifact = run.artifacts.includes("summary.md")
    ? "summary.md"
    : (run.artifacts[0] ?? "summary.md");
  const otherArtifacts = run.artifacts.filter((file) => file !== summaryArtifact);
  const model = modelPoolDisplayName(run.modelPoolId);

  function handleOpen(event: Event): void {
    const target = event.target as HTMLElement;
    if (target.closest("[data-tail], [data-artifact], .btn")) return;
    void openArtifactViewer(`/api/runs/${run.id}/artifacts/${summaryArtifact}`, summaryArtifact);
  }

  return (
    <div
      class="run-item"
      data-run-id={run.id}
      data-run-file={summaryArtifact}
      data-tone={run.status}
      title={`Open ${summaryArtifact}`}
      onClick={handleOpen}
    >
      <StatusBadge status={run.status} />
      <span class="muted">
        {run.agent}
        {model ? <span class="run-model"> · {model}</span> : null}
      </span>
      {run.blockedReason ? <span class="run-blocked">{run.blockedReason}</span> : null}
      <div class="run-item-end">
        <div class="run-item-actions">
          {run.status === "running" ? (
            <button
              class="btn btn-icon btn-ghost"
              type="button"
              data-tail={run.id}
              data-title={run.taskTitle}
              title="Live tail"
            >
              <Icon name="terminal" size={12} />
            </button>
          ) : null}
          {otherArtifacts.map((file) => (
            <button
              class="btn btn-icon btn-ghost"
              type="button"
              key={file}
              data-artifact={`/api/runs/${run.id}/artifacts/${file}`}
              title={`Open ${file}`}
              onClick={(event) => {
                event.stopPropagation();
                void openArtifactViewer(`/api/runs/${run.id}/artifacts/${file}`, file);
              }}
            >
              <Icon name={file.endsWith(".md") ? "file-text" : "file"} size={12} />
            </button>
          ))}
        </div>
        <span class="run-time">{relativeTime(run.completedAt ?? run.startedAt)}</span>
      </div>
    </div>
  );
}

function RunGroup({
  group,
  onToggle
}: {
  group: RunTaskGroup;
  onToggle: (taskId: string, defaultExpanded: boolean) => void;
}) {
  const expanded = isGroupExpanded(group.taskId, group.defaultExpanded);
  const turnLabel = `${group.runs.length} ${group.runs.length === 1 ? "turn" : "turns"}`;

  return (
    <section
      class={`run-group${expanded ? " is-expanded" : ""}`}
      data-tone={group.rollUpStatus}
      data-run-group={group.taskId}
    >
      <div class="run-group-header">
        <button
          type="button"
          class="run-group-toggle"
          data-run-group-toggle={group.taskId}
          aria-expanded={expanded}
          title={expanded ? "Collapse" : "Expand"}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(group.taskId, group.defaultExpanded);
          }}
        >
          <span class={`run-group-chevron${expanded ? " is-open" : ""}`}>
            <Icon name="chevron-right" size={14} />
          </span>
        </button>
        <div class="run-group-summary">
          <div class="run-group-title-line">
            <span class="run-group-title">{group.taskTitle}</span>
            <StatusBadge status={group.rollUpStatus} />
          </div>
          <div class="run-group-meta">
            <span>{turnLabel}</span>
            <span>{relativeTime(group.lastActivityAt)}</span>
          </div>
        </div>
        <button
          class="btn btn-icon btn-ghost"
          type="button"
          data-open-task={group.taskId}
          title="Open task"
          onClick={(event) => {
            event.stopPropagation();
            navigate("task", group.taskId);
          }}
        >
          <Icon name="external-link" size={14} />
        </button>
      </div>
      <div class="run-group-body">
        <div class="run-history">
          {group.runs.map((run) => (
            <RunItem key={run.id} run={run} />
          ))}
        </div>
        {group.runs
          .filter((run) => run.status === "running")
          .map((run) => (
            <TailHost key={`tail-${run.id}`} id={run.id} />
          ))}
      </div>
    </section>
  );
}

/**
 * Renders the grouped run history for a set of runs, owning the expand/collapse
 * state and live-tail binding. Shared by the per-project Runs tab and the
 * System → Maintenance view so both render identical run cards.
 */
export function RunGroupList({ runs }: { runs: HarnessRun[] }) {
  const [, setTick] = useState(0);
  const groups = groupRunsByTask(runs);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) bindTails(ref.current);
  });

  function toggleGroup(taskId: string, defaultExpanded: boolean): void {
    const current = isGroupExpanded(taskId, defaultExpanded);
    expandedGroups.set(taskId, !current);
    setTick((t) => t + 1);
  }

  return (
    <div class="run-groups" ref={ref}>
      {groups.map((group) => (
        <RunGroup key={group.taskId} group={group} onToggle={toggleGroup} />
      ))}
    </div>
  );
}

export function RunsPanel({ projectId }: { projectId: string }) {
  const tasks = ui.data?.tasks ?? [];
  const scopedTaskIds = new Set(
    tasks
      .filter((task) => task.projectId === projectId)
      .map((task) => task.id)
  );
  const runs = (ui.data?.runs ?? []).filter((run) => scopedTaskIds.has(run.taskId));
  const groups = groupRunsByTask(runs);
  const turnLabel = runs.length === 1 ? "turn" : "turns";
  const taskLabel = groups.length === 1 ? "task" : "tasks";

  async function handleCleanRuns(): Promise<void> {
    const ok = await confirm({
      title: "Clean all runs?",
      message: "This permanently removes run history and artifacts. This cannot be undone.",
      confirmLabel: "Clean all",
      tone: "danger"
    });
    if (!ok) return;
    try {
      const r = await api<{ deleted: number }>(`/api/runs/clean?projectId=${encodeURIComponent(projectId)}`, { method: "POST" });
      if (r) toast(`Cleaned ${r.deleted} run(s).`);
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  return (
    <div class="view" id="runsView">
      <div class="view-header">
        <div>
          <h1 class="view-title">Runs</h1>
          <p class="view-subtitle">
            {runs.length} {turnLabel} across {groups.length} {taskLabel}
          </p>
        </div>
        <div class="view-actions">
          <button class="btn btn-danger" type="button" onClick={() => void handleCleanRuns()}>
            <Icon name="trash" size={14} />
            <span>Clean all</span>
          </button>
        </div>
      </div>
      {runs.length === 0 ? (
        <div class="empty-state">
          <h3>No runs yet</h3>
          <p>A run is created every time an agent turn starts.</p>
        </div>
      ) : null}
      <RunGroupList runs={runs} />
    </div>
  );
}
