import { parseTaskFilter, type TaskFilter } from "@ui/features/tasks/filters.js";
import { recordPaletteRecent } from "@ui/overlays/palette-recent.js";
import {
  isSystemSettingsView,
  parseProjectTab,
  parseSettingsSection,
  parseViewName,
  ui,
  type ProjectTab,
  type SettingsSection,
  type ViewName
} from "./state.js";

type Listener = () => void;
const listeners = new Set<Listener>();

export interface NavigateOptions {
  filter?: TaskFilter;
  projectTab?: ProjectTab;
  settingsSection?: SettingsSection;
}

function isTasksDomain(view: ViewName): boolean {
  return view === "tasks" || view === "task";
}

export function buildViewHash(
  view: ViewName,
  taskId: string | null = null,
  filter: TaskFilter = ui.tasksFilter,
  projectTab: ProjectTab = ui.projectTab,
  settingsSection: SettingsSection = ui.settingsSection
): string {
  if (view === "task" && taskId) return `#/task/${taskId}`;
  if (view === "project" && taskId) {
    return projectTab && projectTab !== "overview"
      ? `#/project/${taskId}/${projectTab}`
      : `#/project/${taskId}`;
  }
  if ((view === "tasks" || view === "home") && filter !== "all") {
    return `#/${view}?filter=${encodeURIComponent(filter)}`;
  }
  if (view === "settings" && settingsSection !== "agents") {
    return `#/settings?section=${encodeURIComponent(settingsSection)}`;
  }
  return `#/${view}`;
}

export function shouldClearTaskSelection(from: ViewName, to: ViewName): boolean {
  return isTasksDomain(from) && !isTasksDomain(to);
}

export function navigate(
  view: ViewName,
  taskId: string | null = null,
  options?: NavigateOptions
): void {
  const previousView = ui.view;

  // System destinations live inside Settings; keep deep links / palette working.
  if (isSystemSettingsView(view)) {
    options = { ...options, settingsSection: view as SettingsSection };
    view = "settings";
  }

  if (view === "task" && taskId && previousView !== "task") {
    ui.referringView = previousView;
    ui.referringTasksFilter =
      previousView === "tasks" || previousView === "home" ? ui.tasksFilter : null;
  }

  if (shouldClearTaskSelection(previousView, view)) {
    ui.selectedTaskIds.clear();
  }

  if ((view === "tasks" || view === "home") && options?.filter) {
    ui.tasksFilter = options.filter;
  }
  if (view === "home" && !options?.filter) {
    ui.tasksFilter = "all";
  }

  if (view === "project") {
    ui.projectTab = options?.projectTab ?? "overview";
  }

  if (view === "settings") {
    ui.settingsSection = options?.settingsSection ?? "agents";
  }

  ui.view = view;
  ui.taskId = taskId;

  if (view === "task" && taskId) {
    recordPaletteRecent(`task-${taskId}`);
  } else if (view === "project" && taskId) {
    recordPaletteRecent(`project-${taskId}`);
  } else {
    recordPaletteRecent(`nav-${view}`);
  }

  const hash = buildViewHash(view, taskId, ui.tasksFilter, ui.projectTab, ui.settingsSection);
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
  emit();
}

export function navigateBack(): void {
  const ref = ui.referringView ?? "home";
  if (ref === "tasks" || ref === "home") {
    navigate(ref === "tasks" ? "home" : ref, null, {
      filter: ui.referringTasksFilter ?? "all"
    });
    return;
  }
  navigate(ref);
}

export function onChange(fn: Listener): void {
  listeners.add(fn);
}

function emit(): void {
  for (const fn of listeners) fn();
}

window.addEventListener("hashchange", () => {
  parseHash();
  emit();
});

export function parseHash(): { query: URLSearchParams } {
  const h = window.location.hash || "#/home";
  const raw = h.replace(/^#\/?/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart);
  const head = parts[0];

  const viewName = parseViewName(head);
  const taskId = viewName === "task" || viewName === "project" ? parts[1] ?? null : null;

  if (isSystemSettingsView(viewName)) {
    ui.view = "settings";
    ui.taskId = null;
    ui.settingsSection = viewName as SettingsSection;
  } else {
    ui.view = viewName;
    ui.taskId = taskId;
    if (viewName === "settings") {
      ui.settingsSection = parseSettingsSection(query.get("section"));
    }
  }

  if (viewName === "project" || ui.view === "project") {
    ui.projectTab = parseProjectTab(parts[2]);
  }
  if (ui.view === "tasks" || ui.view === "home") {
    ui.tasksFilter = parseTaskFilter(query.get("filter"));
  }

  return { query };
}
