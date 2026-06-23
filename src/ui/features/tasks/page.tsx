import { useState } from "preact/hooks";
import { render } from "preact";
import { $ } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import {
  ui,
  relativeTime,
  liveness,
  resolvedStepAgent,
  defaultHarnessAgent
} from "@ui/app/state.js";
import { taskIsRunning, taskPmStatus, uiLegacyStatus } from "@ui/app/task-status.js";
import { navigate } from "@ui/app/router.js";
import { toast } from "@ui/overlays/toast.js";
import { softDeleteTasks } from "@ui/features/tasks/delete-undo.js";
import { ViewShell } from "@ui/shared/components/view-shell.js";
import {
  executeTaskAction,
  getPrimaryAction,
  PrimaryActionButton
} from "@ui/shared/components/task-actions.js";
import { BranchChip, MergeRequestChip, StatusBadge } from "@ui/shared/components/task-chips.js";
import { bucketTasks, executionBadgeLabel } from "@ui/features/tasks/filters.js";
import { requestRefresh } from "@ui/data/refresh.js";
import type { HarnessTask } from "@ui/app/types.js";

let tasksHost: HTMLElement | null = null;
let lastClicked: { sectionKey: string; taskId: string } | null = null;

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

async function handleRowAction(action: string, id: string, onChange?: () => void): Promise<void> {
  const task = ui.data?.tasks.find((t) => t.id === id);
  if (!task) return;

  if (action === "delete") {
    softDeleteTasks([task], onChange ?? (() => renderTasksView()));
    return;
  }

  const navigates = action === "run" || action === "resume";
  await executeTaskAction(task, action, {
    onNavigate: (taskId) => navigate("task", taskId),
    refresh: !navigates,
    requeueMessage: "Task requeued.",
    resumeMessage: "Task resumed."
  });
}

function BulkBar({ onChange }: { onChange: () => void }) {
  const count = ui.selectedTaskIds.size;
  const [runProgress, setRunProgress] = useState<{ current: number; total: number } | null>(null);
  if (count === 0) return null;

  async function handleBulkRun(): Promise<void> {
    const tasks = ui.data?.tasks ?? [];
    const ids = [...ui.selectedTaskIds];
    const total = ids.length;
    setRunProgress({ current: 0, total });

    let completed = 0;
    for (const id of ids) {
      const task = tasks.find((t) => t.id === id);
      if (task) {
        await executeTaskAction(task, "run", { refresh: false });
      }
      completed += 1;
      setRunProgress({ current: completed, total });
    }

    toast(`Triggered ${total} run(s).`);
    ui.selectedTaskIds.clear();
    setRunProgress(null);
    onChange();
    requestRefresh();
  }

  function handleBulkDelete(): void {
    const tasks = ui.data?.tasks ?? [];
    const selected = tasks.filter((task) => ui.selectedTaskIds.has(task.id));
    if (!selected.length) return;
    softDeleteTasks(selected, onChange);
  }

  function handleBulkClear(): void {
    ui.selectedTaskIds.clear();
    onChange();
  }

  return (
    <div class="bulk-bar">
      <span class="count">{count}</span>
      <span class="muted">selected</span>
      {runProgress ? (
        <span class="muted" id="bulkRunProgress">
          Running {runProgress.current}/{runProgress.total}
        </span>
      ) : null}
      <button
        class="btn btn-sm"
        type="button"
        id="bulkRun"
        disabled={runProgress !== null}
        onClick={() => void handleBulkRun()}
      >
        <Icon name="play" size={12} />
        <span>Run</span>
      </button>
      <button
        class="btn btn-sm btn-danger"
        type="button"
        id="bulkDelete"
        disabled={runProgress !== null}
        onClick={() => void handleBulkDelete()}
      >
        <Icon name="trash" size={12} />
        <span>Delete</span>
      </button>
      <button class="btn btn-sm btn-ghost" type="button" id="bulkClear" onClick={handleBulkClear}>
        <Icon name="x" size={12} />
        <span>Clear</span>
      </button>
    </div>
  );
}

function TaskRow({
  task,
  sectionKey,
  sectionTasks,
  onChange
}: {
  task: HarnessTask;
  sectionKey: string;
  sectionTasks: HarnessTask[];
  onChange: () => void;
}) {
  const selected = ui.selectedTaskIds.has(task.id);
  const tone = uiLegacyStatus(task);
  const pmStatus = taskPmStatus(task);
  const execLabel = executionBadgeLabel(task);
  const turnLabel = `${task.turnCount ?? 0} ${task.turnCount === 1 ? "turn" : "turns"}`;
  const ageLabel = relativeTime(task.updatedAt ?? task.createdAt);
  const live = liveness(task);
  const primaryAction = getPrimaryAction(task);
  const project = task.projectId
    ? ui.data?.projects?.find((candidate) => candidate.id === task.projectId)
    : undefined;

  function toggleSelected(event: Event): void {
    event.stopPropagation();
    const mouse = event as MouseEvent;
    const index = sectionTasks.findIndex((entry) => entry.id === task.id);

    if (
      mouse.shiftKey &&
      lastClicked?.sectionKey === sectionKey &&
      lastClicked.taskId !== task.id
    ) {
      const anchorIndex = sectionTasks.findIndex((entry) => entry.id === lastClicked!.taskId);
      if (anchorIndex >= 0 && index >= 0) {
        const [start, end] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
        for (let i = start; i <= end; i += 1) {
          ui.selectedTaskIds.add(sectionTasks[i]!.id);
        }
        onChange();
        return;
      }
    }

    if (ui.selectedTaskIds.has(task.id)) ui.selectedTaskIds.delete(task.id);
    else ui.selectedTaskIds.add(task.id);
    lastClicked = { sectionKey, taskId: task.id };
    onChange();
  }

  return (
    <div
      class={`task-row ${selected ? "selected" : ""}`}
      data-tone={tone}
      data-task-row={task.id}
      onClick={() => navigate("task", task.id)}
      tabIndex={0}
    >
      <span
        class={`checkbox ${selected ? "checked" : ""}`}
        data-toggle={task.id}
        onClick={toggleSelected}
      >
        {selected ? <Icon name="check" size={12} /> : null}
      </span>
      <div class="body">
        <div class="title-line">
          <span class="title">{task.title}</span>
          {project ? <span class="project-ticket-badge">{project.name}</span> : null}
          {task.commitCount ? (
            <span class="diff-stat">
              <Icon name="git-commit" size={12} />
              {task.commitCount}
            </span>
          ) : null}
        </div>
        <div class="description">{task.description.split("\n")[0] ?? ""}</div>
        <div class="meta-line" style="margin-top:6px">
          <StatusBadge status={pmStatus} className="badge badge-pm" />
          {execLabel ? (
            <span class="exec-badge exec-badge-inline" data-exec={execLabel.split(" ·")[0]}>
              <span class="dot" />
              {execLabel}
            </span>
          ) : null}
          <span>
            <Icon name="bot" size={12} />
            {resolvedStepAgent(task) ?? defaultHarnessAgent()}
            {task.effort ? ` · ${task.effort}` : ""}
          </span>
          <span>{turnLabel}</span>
          <span>{ageLabel}</span>
          {task.branch ? <BranchChip branch={task.branch} /> : null}
          {task.mergeRequest ? <MergeRequestChip mergeRequest={task.mergeRequest} /> : null}
        </div>
        {live ? (
          <div
            class={`meta-line live-line ${live.warn ? "warn" : ""}`}
            style="margin-top:4px"
          >
            {live.warn ? <Icon name="alert-triangle" size={12} /> : <Icon name="activity" size={12} />}
            <span>{live.text}</span>
          </div>
        ) : null}
      </div>
      {taskIsRunning(task) ? (
        <div class="progress" aria-hidden="true" />
      ) : (
        <span />
      )}
      <div class="row-actions">
        {primaryAction ? (
          <PrimaryActionButton
            spec={primaryAction}
            taskId={task.id}
            onClick={(event) => {
              event.stopPropagation();
              void handleRowAction(primaryAction.action, task.id, onChange);
            }}
          />
        ) : null}
        <button
          class="btn btn-icon btn-ghost"
          type="button"
          title="Delete"
          onClick={(event) => {
            event.stopPropagation();
            void handleRowAction("delete", task.id, onChange);
          }}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

function TaskSection({
  section,
  onChange
}: {
  section: { key: string; title: string; tasks: HarnessTask[] };
  onChange: () => void;
}) {
  const allSelected =
    section.tasks.length > 0 && section.tasks.every((task) => ui.selectedTaskIds.has(task.id));
  const someSelected = section.tasks.some((task) => ui.selectedTaskIds.has(task.id));

  function toggleSectionSelected(event: Event): void {
    event.stopPropagation();
    if (allSelected) {
      for (const task of section.tasks) ui.selectedTaskIds.delete(task.id);
    } else {
      for (const task of section.tasks) ui.selectedTaskIds.add(task.id);
    }
    onChange();
  }

  return (
    <div class="list-section">
      <div class="list-section-header">
        <span
          class={`checkbox section-select ${allSelected ? "checked" : someSelected ? "indeterminate" : ""}`}
          data-section-select={section.key}
          title="Select all in section"
          onClick={toggleSectionSelected}
        >
          {allSelected ? <Icon name="check" size={12} /> : someSelected ? <span class="indeterminate-mark" /> : null}
        </span>
        {section.title}
        <span class="count">{section.tasks.length}</span>
      </div>
      <div class="task-list">
        {section.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            sectionKey={section.key}
            sectionTasks={section.tasks}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}

function GlobalSelectBar({
  sections,
  onChange
}: {
  sections: Array<{ key: string; title: string; tasks: HarnessTask[] }>;
  onChange: () => void;
}) {
  const visible = sections.flatMap((section) => section.tasks);
  if (!visible.length) return null;

  const allSelected = visible.every((task) => ui.selectedTaskIds.has(task.id));
  const someSelected = visible.some((task) => ui.selectedTaskIds.has(task.id));

  function toggleAll(event: Event): void {
    event.stopPropagation();
    if (allSelected) {
      for (const task of visible) ui.selectedTaskIds.delete(task.id);
    } else {
      for (const task of visible) ui.selectedTaskIds.add(task.id);
    }
    onChange();
  }

  return (
    <div class="list-global-select">
      <span
        class={`checkbox global-select ${allSelected ? "checked" : someSelected ? "indeterminate" : ""}`}
        data-global-select
        title="Select all visible tasks"
        onClick={toggleAll}
      >
        {allSelected ? <Icon name="check" size={12} /> : someSelected ? <span class="indeterminate-mark" /> : null}
      </span>
      <span class="muted">Select all visible</span>
    </div>
  );
}

function TasksList({ onChange }: { onChange: () => void }) {
  const tasks = ui.data?.tasks ?? [];
  const sections = bucketTasks(tasks, ui.tasksFilter).filter((s) => s.tasks.length > 0);

  return (
    <>
      <GlobalSelectBar sections={sections} onChange={onChange} />
      {sections.map((section) => (
        <TaskSection key={section.key} section={section} onChange={onChange} />
      ))}
      <BulkBar onChange={onChange} />
    </>
  );
}

function TasksView() {
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  const tasks = ui.data?.tasks ?? [];

  function handleNewTask(): void {
    document.dispatchEvent(new CustomEvent("harness:new-task"));
  }

  function handleFilterReset(): void {
    navigate("tasks", null, { filter: "all" });
  }

  if (!tasks.length) {
    return (
      <ViewShell
        title="Tasks"
        subtitle="Tickets created from the home chat and connector imports appear here."
        actions={
          <button class="btn btn-primary" type="button" onClick={handleNewTask}>
            <Icon name="sparkles" size={14} />
            <span>Start on Home</span>
          </button>
        }
      >
        <div class="empty-state">
          <h3>No tasks yet</h3>
          <p>
            Go to <strong>Home</strong> and describe what you want to build, or press <kbd>N</kbd>.
          </p>
        </div>
      </ViewShell>
    );
  }

  return (
    <ViewShell
      id="tasksView"
      title="Tasks"
      subtitle={`${tasks.length} total`}
      actions={
        <>
          <button
            class="btn"
            type="button"
            disabled={ui.tasksFilter === "all"}
            onClick={handleFilterReset}
          >
            <Icon name="refresh" size={14} />
            <span>Clear filter</span>
          </button>
          <button class="btn btn-primary" type="button" onClick={handleNewTask}>
            <Icon name="sparkles" size={14} />
            <span>New task</span>
          </button>
        </>
      }
    >
      <div id="tasksListHost">
        <TasksList onChange={bump} />
      </div>
    </ViewShell>
  );
}

function mountTasks(): void {
  const root = $("#viewContent");
  if (!root) return;
  tasksHost = root;
  render(<TasksView />, root);
}

export function updateTasksView(): void {
  if (!tasksHost || !$("#tasksView")) {
    renderTasksView();
    return;
  }
  render(<TasksView />, tasksHost);
}

export function renderTasksView(): void {
  mountTasks();
}
