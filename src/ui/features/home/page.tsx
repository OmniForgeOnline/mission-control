import { render } from "preact";

import { ui, relativeTime } from "@ui/app/state.js";
import { navigate } from "@ui/app/router.js";
import { $ } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { MergeRequestChip } from "@ui/shared/components/task-chips.js";
import { awaitingMergeTasks, mergeAttentionState } from "./selectors.js";
import type { HarnessTask, ProjectSummary } from "@ui/app/types.js";

let homeHost: HTMLElement | null = null;

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function projectTicketCount(project: ProjectSummary): number {
  return (ui.data?.tasks ?? []).filter((task) => task.projectId === project.id).length;
}

function projectName(task: HarnessTask): string | undefined {
  if (!task.projectId) return undefined;
  return ui.data?.projects?.find((project) => project.id === task.projectId)?.name;
}

function AwaitingMergeSection({ tasks }: { tasks: HarnessTask[] }) {
  if (!tasks.length) return null;
  const openCount = tasks.filter((task) => mergeAttentionState(task).tone === "open").length;
  const closedCount = tasks.length - openCount;

  return (
    <section class="home-attention">
      <div class="project-section-head">
        <h2>Awaiting review &amp; merge</h2>
        <span class="muted">
          {openCount} open · {closedCount} closed
        </span>
      </div>
      <div class="home-attention-list">
        {tasks.map((task) => {
          const state = mergeAttentionState(task);
          const project = projectName(task);
          return (
            <button
              class="home-attention-row"
              type="button"
              key={task.id}
              data-tone={state.tone}
              onClick={() => navigate("task", task.id)}
            >
              <span class="home-attention-main">
                <strong class="home-attention-title">{task.title}</strong>
                <span class="home-attention-meta">
                  {project ? <span class="home-attention-project">{project}</span> : null}
                  {task.mergeRequest ? <MergeRequestChip mergeRequest={task.mergeRequest} /> : null}
                  <span class={`merge-state merge-state-${state.tone}`} data-tone={state.tone}>
                    {state.tone === "closed" ? <Icon name="alert-triangle" size={12} /> : null}
                    {state.label}
                  </span>
                  <span class="muted">{relativeTime(task.createdAt)}</span>
                </span>
              </span>
              <Icon name="chevron-right" size={16} />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SetupChecklist({ hasProjects }: { hasProjects: boolean }) {
  const items = [
    {
      iconName: "terminal",
      title: "Install an agent CLI",
      body: "Confirm `claude`, `codex`, `grok`, `opencode`, or an ACP-compatible tool is on your PATH.",
      done: false
    },
    {
      iconName: "folder",
      title: "Add your first project",
      body: hasProjects ? "A local git project is ready for scoped tickets." : "Use the + next to Projects to select a local git repository.",
      done: hasProjects
    },
    {
      iconName: "bot",
      title: "Configure agents",
      body: "Choose a default agent and confirm available CLI tools in Settings.",
      done: false,
      action: () => navigate("settings")
    },
    {
      iconName: "external-link",
      title: "Connect GitHub or GitLab",
      body: "Optional: add a connector only when you want PR or MR workflows.",
      done: false,
      action: () => navigate("connectors")
    },
    {
      iconName: "play",
      title: "Run a quickstart",
      body: "Open a project and pick one of its generated quickstarts to see the workflow loop.",
      done: false
    }
  ];

  return (
    <section class="home-setup-checklist" aria-labelledby="homeSetupTitle">
      <div class="project-section-head">
        <div>
          <h2 id="homeSetupTitle">First run setup</h2>
          <p class="home-setup-subtitle">Recommended order before the first real ticket.</p>
        </div>
        <span class="badge">{items.filter((item) => item.done).length}/{items.length}</span>
      </div>
      <div class="home-setup-grid">
        {items.map((item) => {
          const content = (
            <>
              <span class={`home-setup-icon${item.done ? " is-done" : ""}`}>
                <Icon name={item.done ? "check" : item.iconName} size={16} />
              </span>
              <span class="home-setup-copy">
                <strong>{item.title}</strong>
                <span>{item.body}</span>
              </span>
              {item.action ? <Icon name="chevron-right" size={15} /> : null}
            </>
          );

          return item.action ? (
            <button class="home-setup-item is-action" type="button" key={item.title} onClick={item.action}>
              {content}
            </button>
          ) : (
            <div class="home-setup-item" key={item.title}>
              {content}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function HomeView() {
  const projects = ui.data?.projects ?? [];
  const awaiting = awaitingMergeTasks(ui.data?.tasks ?? []);

  return (
    <div class="view intake-view" id="homeView">
      <div class="intake-layout">
        <header class="intake-header">
          <div>
            <h1 class="view-title">Mission Control</h1>
            <p class="view-subtitle">
              Choose a project to start a scoped ticket. Tickets always belong to a project.
            </p>
          </div>
          <div class="view-actions">
            <button class="btn btn-ghost" type="button" onClick={() => navigate("tasks")}>
              <Icon name="list-checks" size={14} />
              <span>All tasks</span>
            </button>
          </div>
        </header>
        <AwaitingMergeSection tasks={awaiting} />
        <SetupChecklist hasProjects={projects.length > 0} />
        <section class="project-picker">
          <div class="project-section-head">
            <h2>Projects</h2>
            <span class="muted">{projects.length ? `${projects.length} available` : "No projects"}</span>
          </div>
          {projects.length ? (
            <div class="project-picker-grid">
              {projects.map((project) => (
                <button
                  class="project-picker-card"
                  type="button"
                  key={project.id}
                  onClick={() => navigate("project", project.id)}
                >
                  <span class="project-picker-icon">
                    <Icon name="folder" size={18} />
                  </span>
                  <span class="project-picker-body">
                    <strong>{project.name}</strong>
                    <span>{project.repoPath}</span>
                  </span>
                  <span class="badge">{projectTicketCount(project)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div class="empty-state">
              <h3>No projects</h3>
              <p>Add a project before creating tickets.</p>
            </div>
          )}
        </section>
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
