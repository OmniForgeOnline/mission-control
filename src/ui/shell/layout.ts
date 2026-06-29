import { $, escapeHtml } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { ui, type ViewName } from "@ui/app/state.js";
import { navigate } from "@ui/app/router.js";
import { countTaskBuckets, type TaskFilter } from "@ui/features/tasks/filters.js";
import { taskIsComplete, uiLegacyStatus } from "@ui/app/task-status.js";
import type { HarnessTask } from "@ui/app/types.js";
import { updatePillHtml, bindUpdatePill } from "@ui/shell/update-pill.js";

let eventsConnected = true;
const PROJECT_COLLAPSE_KEY = "harness:rail:collapsed-projects";
const PROJECT_EXPAND_KEY = "harness:rail:expanded-projects";
const RAIL_TICKET_LIMIT = 4;

export function updateConnectionStatus(connected: boolean): void {
  eventsConnected = connected;
  const indicator = $("#connectionStatus");
  if (indicator) indicator.classList.toggle("is-visible", !connected);
}

/** Patch status pill counts in-place without rebuilding chrome DOM. */
export function updateChromeCounts(): void {
  const data = ui.data;
  if (!data) return;

  const buckets = countTaskBuckets(data.tasks);
  const { running, awaiting, blocked, resumable } = buckets;

  const pills: Record<string, number> = {
    running,
    awaiting,
    blocked,
    resumable
  };

  $("#appBar")?.querySelectorAll<HTMLButtonElement>(".status-pill").forEach((pill) => {
    const filter = pill.dataset["filter"];
    if (!filter || !(filter in pills)) return;
    const count = pills[filter]!;
    const dot = pill.querySelector(".dot");
    const label = filter === "running" ? "running" : filter === "awaiting" ? "await" : filter;
    pill.textContent = "";
    if (dot) pill.appendChild(dot);
    pill.append(`${count} ${label}`);
    pill.hidden = filter === "blocked" || filter === "resumable" ? count === 0 : false;
  });

  updateRailCounts(data);
}

function updateRailCounts(data: NonNullable<typeof ui.data>): void {
  const counts = countTaskBuckets(data.tasks);

  $("#appRail")?.querySelectorAll<HTMLElement>(".rail-link").forEach((link) => {
    const filter = link.dataset["filter"];
    if (!filter || !(filter in counts)) return;
    const badge = link.querySelector(".count");
    if (badge) badge.textContent = String(counts[filter as keyof typeof counts]);
  });
}

export function renderAppBar(): void {
  const bar = $("#appBar");
  if (!bar) return;
  const data = ui.data;
  const buckets = countTaskBuckets(data?.tasks ?? []);
  const { running, awaiting, blocked, resumable } = buckets;

  bar.innerHTML = `
    <button class="brand brand-btn" id="brandHome" type="button" title="OmniForge — Home">
      <img class="brand-mark" src="/omniforge-mark.png" alt="OmniForge" width="26" height="26" decoding="async" />
      <span class="brand-wordmark">
        <span class="brand-name">OmniForge</span>
        <span class="brand-sep" aria-hidden="true"></span>
        <span class="brand-sub">Mission Control</span>
      </span>
    </button>
    ${updatePillHtml()}
    <div class="app-bar-spacer"></div>
    <button class="palette-trigger" id="paletteTrigger" title="Open command palette">
      ${icon("search", 14)}
      <span>Search…</span>
      <kbd>⌘K</kbd>
    </button>
    <div class="status-pills">
      <button class="status-pill" data-tone="running" data-filter="running" title="Running tasks">
        <span class="dot"></span>
        ${running} running
      </button>
      <button class="status-pill" data-tone="awaiting" data-filter="awaiting" title="Awaiting reply / review">
        <span class="dot"></span>
        ${awaiting} await
      </button>
      ${
        blocked > 0
          ? `<button class="status-pill" data-tone="blocked" data-filter="blocked" title="Blocked tasks"><span class="dot"></span>${blocked} blocked</button>`
          : ""
      }
      ${
        resumable > 0
          ? `<button class="status-pill" data-tone="resumable" data-filter="resumable" title="Paused / interrupted tasks"><span class="dot"></span>${resumable} resumable</button>`
          : ""
      }
    </div>
    <span class="connection-status${eventsConnected ? "" : " is-visible"}" id="connectionStatus">
      ${icon("refresh", 12)}
      Reconnecting…
    </span>
  `;

  $("#brandHome")?.addEventListener("click", () => navigate("home"));
  $("#paletteTrigger")?.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("harness:open-palette"));
  });
  bar.querySelectorAll<HTMLButtonElement>(".status-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      const filter = btn.dataset["filter"];
      if (filter) {
        navigate("tasks", null, { filter: filter as TaskFilter });
      } else {
        navigate("tasks");
      }
    });
  });

  bindUpdatePill();
}

interface RailItem {
  view: ViewName;
  label: string;
  iconName: string;
  count?: number;
  tone?: "warn" | "active";
  filter?: string;
}

export function renderRail(): void {
  const rail = $("#appRail");
  if (!rail) return;
  const data = ui.data;
  const tasks = data?.tasks ?? [];

  const taskItems: RailItem[] = [
    { view: "home", label: "Home", iconName: "sparkles" },
    { view: "tasks", label: "All tasks", iconName: "list-checks", count: tasks.length, filter: "all" }
  ];

  const systemItems: RailItem[] = [
    { view: "connectors", label: "Connectors", iconName: "external-link" },
    { view: "skills", label: "Skills", iconName: "sparkles" },
    { view: "workflows", label: "Workflows", iconName: "workflow" },
    { view: "maintenance", label: "Maintenance", iconName: "activity" }
  ];

  const settingsItem: RailItem = { view: "settings", label: "Settings", iconName: "settings" };

  rail.innerHTML = `
    <div class="rail-section">
      ${taskItems.map(railItemHtml).join("")}
    </div>
    ${projectRailHtml()}
    <div class="rail-heading">System</div>
    <div class="rail-section">
      ${systemItems.map(railItemHtml).join("")}
    </div>
    <div class="rail-spacer"></div>
    <div class="rail-section rail-section-footer">
      ${railItemHtml(settingsItem)}
    </div>
  `;

  rail.querySelectorAll<HTMLElement>(".rail-link").forEach((link) => {
    link.addEventListener("click", () => {
      const view = link.dataset["view"] as ViewName;
      const filter = link.dataset["filter"] as TaskFilter | undefined;
      if (view === "tasks" && filter) {
        navigate("tasks", null, { filter });
        return;
      }
      const projectId = link.dataset["projectId"];
      navigate(view, projectId ?? null);
    });
  });

  rail.querySelector<HTMLElement>("[data-new-project]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    document.dispatchEvent(new CustomEvent("harness:new-project"));
  });

  rail.querySelectorAll<HTMLElement>("[data-collapse-project-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const projectId = button.dataset["collapseProjectId"];
      if (projectId) toggleProjectCollapse(projectId);
    });
  });

  rail.querySelectorAll<HTMLElement>("[data-expand-project-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const projectId = button.dataset["expandProjectId"];
      if (projectId) toggleProjectExpand(projectId);
    });
  });

  rail.querySelectorAll<HTMLElement>(".rail-project-ticket").forEach((button) => {
    button.addEventListener("click", () => {
      const taskId = button.dataset["taskId"];
      if (taskId) {
        navigate("task", taskId);
        return;
      }
      const projectId = button.dataset["projectId"];
      if (projectId) navigate("project", projectId);
    });
  });

  const targetView: string = ui.view === "task" ? "tasks" : ui.view;
  const activeFilter = ui.view === "tasks" || ui.view === "task" ? ui.tasksFilter : null;

  rail.querySelectorAll<HTMLElement>(".rail-link").forEach((link) => {
    const view = link.dataset["view"];
    if (view !== targetView) return;

    if (targetView === "project") {
      if (link.dataset["projectId"] === ui.taskId) {
        link.classList.add("active");
      }
      return;
    }

    if (targetView === "tasks") {
      const linkFilter = link.dataset["filter"] ?? "all";
      if (linkFilter === (activeFilter ?? "all")) {
        link.classList.add("active");
      }
      return;
    }

    if (!link.dataset["filter"]) {
      link.classList.add("active");
    }
  });
}

function projectRailHtml(): string {
  const projects = ui.data?.projects ?? [];
  const tasks = ui.data?.tasks ?? [];
  const collapsed = readCollapsedProjects();
  const expanded = readExpandedProjects();
  const rows = projects.map((project) => {
    const scoped = tasks.filter((task) => task.projectId === project.id);
    const open = scoped
      .filter((task) => !taskIsComplete(task))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const isCollapsed = collapsed.has(project.id);
    const isExpanded = expanded.has(project.id);
    const visible = isExpanded ? open : open.slice(0, RAIL_TICKET_LIMIT);
    const overflow = Math.max(open.length - visible.length, 0);
    return `
      <div class="rail-project${isCollapsed ? " collapsed" : ""}">
        <div class="rail-project-head">
          <button class="rail-project-toggle" data-collapse-project-id="${escapeHtml(project.id)}" type="button" title="${isCollapsed ? "Expand project" : "Collapse project"}">
            ${icon(isCollapsed ? "chevron-right" : "chevron-down", 14)}
          </button>
          <button class="rail-link rail-project-link" data-view="project" data-project-id="${escapeHtml(project.id)}" type="button">
            ${icon("folder", 16)}
            <span class="label">${escapeHtml(project.name)}</span>
            ${open.length ? `<span class="count">${open.length}</span>` : ""}
          </button>
        </div>
        ${projectStatusHtml(scoped)}
        <div class="rail-project-tickets">
          ${
            visible.length
              ? visible.map(projectTicketHtml).join("")
              : `<span class="rail-project-empty">No open tickets</span>`
          }
          ${railExpandToggleHtml(project.id, overflow, isExpanded, open.length)}
        </div>
      </div>
    `;
  });
  return `
    <div class="rail-heading rail-heading-row">
      <span>Projects</span>
      <button class="rail-heading-action" data-new-project type="button" title="Add project" aria-label="Add project">
        ${icon("plus", 14)}
      </button>
    </div>
    <div class="rail-section rail-projects">
      ${
        rows.length
          ? rows.join("")
          : `<span class="rail-project-empty rail-projects-empty">No projects yet. Select a folder with +.</span>`
      }
    </div>
  `;
}

function railExpandToggleHtml(
  projectId: string,
  overflow: number,
  isExpanded: boolean,
  openCount: number
): string {
  if (!isExpanded && overflow > 0) {
    return `<button class="rail-project-ticket rail-project-more" data-expand-project-id="${escapeHtml(projectId)}" type="button">+${overflow} more</button>`;
  }
  if (isExpanded && openCount > RAIL_TICKET_LIMIT) {
    return `<button class="rail-project-ticket rail-project-more" data-expand-project-id="${escapeHtml(projectId)}" type="button">Show less</button>`;
  }
  return "";
}

function projectStatusHtml(tasks: HarnessTask[]): string {
  const counts = countTaskBuckets(tasks);
  const entries = [
    { key: "running", label: "active", count: counts.running, tone: "active" },
    { key: "awaiting", label: "awaiting", count: counts.awaiting, tone: "warn" },
    { key: "queue", label: "queued", count: counts.queue, tone: "neutral" },
    { key: "blocked", label: "blocked", count: counts.blocked, tone: "blocked" }
  ].filter((entry) => entry.count > 0);

  if (!entries.length) return "";
  return `
    <div class="rail-project-status">
      ${entries.map((entry) => `<span data-tone="${entry.tone}" title="${entry.key}">${entry.label} ${entry.count}</span>`).join("")}
    </div>
  `;
}

function projectTicketHtml(task: HarnessTask): string {
  const status = uiLegacyStatus(task);
  return `
    <button class="rail-project-ticket" data-view="task" data-task-id="${escapeHtml(task.id)}" type="button" title="${escapeHtml(task.title)}">
      <span class="rail-project-ticket-status" data-status="${escapeHtml(status)}"></span>
      <span class="rail-project-ticket-title">${escapeHtml(task.title)}</span>
    </button>
  `;
}

function readCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(PROJECT_COLLAPSE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedProjects(collapsed: Set<string>): void {
  localStorage.setItem(PROJECT_COLLAPSE_KEY, JSON.stringify([...collapsed]));
}

function toggleProjectCollapse(projectId: string): void {
  const collapsed = readCollapsedProjects();
  if (collapsed.has(projectId)) {
    collapsed.delete(projectId);
  } else {
    collapsed.add(projectId);
  }
  writeCollapsedProjects(collapsed);
  renderRail();
}

function readExpandedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(PROJECT_EXPAND_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpandedProjects(expanded: Set<string>): void {
  localStorage.setItem(PROJECT_EXPAND_KEY, JSON.stringify([...expanded]));
}

function toggleProjectExpand(projectId: string): void {
  const expanded = readExpandedProjects();
  if (expanded.has(projectId)) {
    expanded.delete(projectId);
  } else {
    expanded.add(projectId);
  }
  writeExpandedProjects(expanded);
  renderRail();
}

function railItemHtml(item: RailItem): string {
  const count =
    item.count !== undefined && item.count !== null
      ? `<span class="count" ${item.tone ? `data-tone="${item.tone}"` : ""}>${item.count}</span>`
      : "";
  return `
    <button class="rail-link" data-view="${item.view}"${item.filter ? ` data-filter="${item.filter}"` : ""} type="button">
      ${icon(item.iconName, 14)}
      <span class="label">${item.label}</span>
      ${count}
    </button>
  `;
}
