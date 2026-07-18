import { render } from "preact";
import { useEffect } from "preact/hooks";

import { ui, relativeTime, liveness } from "@ui/app/state.js";
import { navigate } from "@ui/app/router.js";
import { $ } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { MergeRequestChip } from "@ui/shared/components/task-chips.js";
import {
  attentionFocusIds,
  attentionSections,
  mergeAttentionState,
  type AttentionSection,
  type AttentionSectionId
} from "./selectors.js";
import { SetupChecklist } from "./setup-checklist.js";
import type { HarnessTask } from "@ui/app/types.js";

let homeHost: HTMLElement | null = null;

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function projectName(task: HarnessTask): string | undefined {
  if (!task.projectId) return undefined;
  return ui.data?.projects?.find((project) => project.id === task.projectId)?.name;
}

function rowMeta(task: HarnessTask, sectionId: AttentionSectionId): {
  label: string;
  tone: string;
} {
  if (sectionId === "merge") {
    const state = mergeAttentionState(task);
    return { label: state.label, tone: state.tone };
  }
  if (sectionId === "stalled") {
    const live = liveness(task);
    return { label: live?.text ?? "Stalled", tone: "stalled" };
  }
  if (sectionId === "blocked") {
    return { label: task.blockedReason?.trim() || "Blocked", tone: "blocked" };
  }
  if (sectionId === "resumable") {
    return { label: task.pausedAt ? "Paused" : "Interrupted", tone: "resumable" };
  }
  if (sectionId === "awaiting") {
    return { label: "Needs reply", tone: "awaiting" };
  }
  const live = liveness(task);
  return { label: live?.text ?? "Running", tone: "running" };
}

function AttentionRow({
  task,
  sectionId
}: {
  task: HarnessTask;
  sectionId: AttentionSectionId;
}) {
  const project = projectName(task);
  const meta = rowMeta(task, sectionId);

  return (
    <button
      class="home-attention-row"
      type="button"
      data-tone={meta.tone}
      onClick={() => navigate("task", task.id)}
    >
      <span class="home-attention-main">
        <strong class="home-attention-title">{task.title}</strong>
        <span class="home-attention-meta">
          {project ? <span class="home-attention-project">{project}</span> : null}
          {task.mergeRequest && sectionId === "merge" ? (
            <MergeRequestChip mergeRequest={task.mergeRequest} />
          ) : null}
          <span class={`merge-state merge-state-${meta.tone}`} data-tone={meta.tone}>
            {meta.tone === "closed" || meta.tone === "blocked" || meta.tone === "stalled" ? (
              <Icon name="alert-triangle" size={12} />
            ) : null}
            {meta.label}
          </span>
          <span class="muted">{relativeTime(task.updatedAt)}</span>
        </span>
      </span>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}

function AttentionSectionBlock({
  section,
  focused
}: {
  section: AttentionSection;
  focused: boolean;
}) {
  return (
    <section
      class={`home-attention${focused ? " is-focused" : ""}`}
      id={`home-section-${section.id}`}
      data-section={section.id}
    >
      <div class="project-section-head">
        <h2>{section.title}</h2>
        <span class="muted">{section.tasks.length}</span>
      </div>
      <div class="home-attention-list">
        {section.tasks.map((task) => (
          <AttentionRow key={task.id} task={task} sectionId={section.id} />
        ))}
      </div>
    </section>
  );
}

function HomeView() {
  const projects = ui.data?.projects ?? [];
  const sections = attentionSections(ui.data?.tasks ?? []);
  const focusIds = attentionFocusIds(ui.tasksFilter);
  const total = sections.reduce((sum, section) => sum + section.tasks.length, 0);

  useEffect(() => {
    if (focusIds.size === 0) return;
    const first = sections.find((section) => focusIds.has(section.id));
    if (!first) return;
    document.getElementById(`home-section-${first.id}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }, [ui.tasksFilter, sections.map((s) => s.id).join(",")]);

  return (
    <div class="view intake-view" id="homeView">
      <div class="intake-layout">
        <header class="intake-header">
          <div>
            <h1 class="view-title">Needs attention</h1>
          </div>
          {total > 0 ? <span class="badge">{total}</span> : null}
        </header>

        <SetupChecklist hasProjects={projects.length > 0} />

        {sections.length ? (
          sections.map((section) => (
            <AttentionSectionBlock
              key={section.id}
              section={section}
              focused={focusIds.has(section.id)}
            />
          ))
        ) : (
          <div class="empty-state home-clear">
            <h3>All clear</h3>
            <p>Nothing needs attention right now. Open a project in the sidebar to create a ticket.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function mountHome(): void {
  const root = $("#viewContent");
  if (!root) return;
  homeHost = root;
  render(<HomeView />, root);
}

export function updateHomeView(): void {
  if (!homeHost || !$("#homeView")) {
    renderHomeView();
    return;
  }
  render(<HomeView />, homeHost);
}

export function renderHomeView(): void {
  mountHome();
}

export function focusIntakeInput(): void {
  const firstProject = ui.data?.projects?.[0];
  if (firstProject) navigate("project", firstProject.id);
}
