import { parseTaskFilter, type TaskFilter } from "@ui/features/tasks/filters.js";
import { recordPaletteRecent } from "@ui/overlays/palette-recent.js";
import {
  parseProjectTab,
  parseViewName,
  ui,
  type ProjectTab,
  type ViewName
} from "./state.js";

type Listener = () => void;
const listeners = new Set<Listener>();

export interface NavigateOptions {
  filter?: TaskFilter;
  projectTab?: ProjectTab;
}

function isTasksDomain(view: ViewName): boolean {
  return view === "tasks" || view === "task";
}

export function buildViewHash(
  view: ViewName,
  taskId: string | null = null,
  filter: TaskFilter = ui.tasksFilter,
  projectTab: ProjectTab = ui.projectTab
): string {
  if (view === "task" && taskId) return `#/task/${taskId}`;
  if (view === "project" && taskId) {
    return projectTab && projectTab !== "overview"
      ? `#/project/${taskId}/${projectTab}`
      : `#/project/${taskId}`;
  }
  if (view === "tasks" && filter !== "all") return `#/tasks?filter=${encodeURIComponent(filter)}`;
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

  if (view === "task" && taskId && previousView !== "task") {
    ui.referringView = previousView;
    ui.referringTasksFilter = previousView === "tasks" ? ui.tasksFilter : null;
  }

  if (shouldClearTaskSelection(previousView, view)) {
    ui.selectedTaskIds.clear();
  }

  if (view === "tasks" && options?.filter) {
    ui.tasksFilter = options.filter;
  }

  if (view === "project") {
    ui.projectTab = options?.projectTab ?? "overview";
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

  const hash = buildViewHash(view, taskId, ui.tasksFilter);
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
  emit();
}

export function navigateBack(): void {
  const ref = ui.referringView ?? "tasks";
  if (ref === "tasks") {
    navigate("tasks", null, { filter: ui.referringTasksFilter ?? "all" });
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

  ui.view = viewName;
  ui.taskId = taskId;
  if (viewName === "project") {
    ui.projectTab = parseProjectTab(parts[2]);
  }
  if (viewName === "tasks") {
    ui.tasksFilter = parseTaskFilter(query.get("filter"));
  }

  return { query };
}
