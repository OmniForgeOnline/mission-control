import { api } from "@ui/data/api.js";
import { $ } from "@ui/shell/dom.js";
import { ui, setTheme } from "@ui/app/state.js";
import { onChange, parseHash, navigate } from "@ui/app/router.js";
import { renderAppBar, renderRail, updateChromeCounts, updateConnectionStatus } from "@ui/shell/layout.js";
import { restoreRailWidthEarly, setupRailResize } from "@ui/shell/rail-resize.js";
import { openCaptureMemory, openMemoryPreview, setWorkflowChoices } from "@ui/overlays/slideover.js";
import { openPalette } from "@ui/overlays/palette.js";
import { dismissTopmostOverlay, hasOpenOverlay } from "@ui/overlays/dialog.js";
import { openShortcuts } from "@ui/overlays/shortcuts.js";
import { initTargetSuggest } from "@ui/overlays/target-suggest.js";
import { connectStateEvents, onConnectionChange } from "@ui/data/events.js";
import {
  includesScope,
  includesTaskActivityScope,
  includesTaskScope,
  unionScopes,
  type StateScope
} from "@ui/app/scopes.js";
import { userIsEditing } from "@ui/shell/focus.js";
import type { AppState, MemoryPage } from "@ui/app/types.js";
import { VIEW_REGISTRY } from "./registry.js";
import { focusIntakeInput } from "@ui/features/home/page.js";
import { addProjectViaPicker } from "@ui/features/projects/add.js";

parseHash();
restoreRailWidthEarly();

let refreshPending = false;
let pendingScopes: StateScope[] = [];
let debounceTimer: number | null = null;

function applyState(data: AppState): void {
  ui.data = data;
  setWorkflowChoices((data.workflows ?? []).map((w) => ({ id: w.id, name: w.name })));
  const theme = data.settings?.theme;
  if (theme === "dark" || theme === "light") {
    setTheme(theme);
  }
}

function renderChrome(): void {
  renderAppBar();
  renderRail();
}

function renderCurrentView(): void {
  const entry = VIEW_REGISTRY[ui.view] ?? VIEW_REGISTRY.home;
  void entry.render();
}

function render(): void {
  renderChrome();
  renderCurrentView();
}

function applyScopes(scopes: StateScope[]): void {
  if (includesScope(scopes, "all")) {
    render();
    return;
  }

  const activityOnly =
    ui.view === "task" &&
    includesTaskActivityScope(scopes, ui.taskId) &&
    !includesTaskScope(scopes, ui.taskId) &&
    !includesScope(scopes, "chrome") &&
    !includesScope(scopes, "tasks");

  if (activityOnly) {
    VIEW_REGISTRY.task.applyScopes?.(scopes);
    return;
  }

  if (includesScope(scopes, "chrome") || includesScope(scopes, "tasks")) {
    if ($("#appBar")?.querySelector(".status-pills")) {
      updateChromeCounts();
    } else {
      renderChrome();
    }
  }

  VIEW_REGISTRY[ui.view]?.applyScopes?.(scopes);
}

async function refresh(scopes: StateScope[] = ["all"]): Promise<void> {
  if (refreshPending) {
    pendingScopes = unionScopes(pendingScopes, scopes);
    return;
  }
  refreshPending = true;
  const activeScopes = scopes;
  try {
    const next = await api<AppState>("/api/state");
    if (!next) return;
    applyState(next);
    applyScopes(activeScopes);
  } finally {
    refreshPending = false;
    if (pendingScopes.length) {
      const queued = pendingScopes;
      pendingScopes = [];
      void refresh(queued);
    }
  }
}

function scheduleRefresh(scopes: StateScope[]): void {
  pendingScopes = unionScopes(pendingScopes, scopes);
  if (debounceTimer !== null) return;
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    const batch = pendingScopes;
    pendingScopes = [];
    void refresh(batch.length ? batch : ["all"]);
  }, 150);
}

function handleStateEvent(scopes: StateScope[]): void {
  scheduleRefresh(scopes);
}

onChange(() => {
  renderChrome();
  renderCurrentView();
});

document.addEventListener("harness:refresh", () => {
  void refresh(["all"]);
});
document.addEventListener("harness:refresh-render", () => {
  renderChrome();
  renderCurrentView();
});
document.addEventListener("harness:open-palette", () => {
  if (!hasOpenOverlay()) openPalette();
});
document.addEventListener("harness:new-task", () => {
  navigate("home");
  focusIntakeInput();
});
document.addEventListener("harness:new-project", () => {
  void addProjectViaPicker();
});
document.addEventListener("harness:capture-memory", (event) => {
  const detail = (event as CustomEvent<{ projectId?: string }>).detail;
  openCaptureMemory(detail?.projectId ? { projectId: detail.projectId } : undefined);
});
document.addEventListener("harness:open-memory", (event) => {
  openMemoryPreview((event as CustomEvent<MemoryPage>).detail);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !userIsEditing()) void refresh(["all"]);
});

let goPrefix = false;

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  const inField =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable;

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!hasOpenOverlay()) openPalette();
    return;
  }

  if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    openShortcuts();
    return;
  }

  if (inField) return;

  if (goPrefix) {
    const map: Record<string, () => void> = {
      h: () => navigate("home"),
      t: () => navigate("tasks"),
      s: () => navigate("skills"),
      c: () => navigate("connectors"),
      m: () => navigate("maintenance")
    };
    const fn = map[event.key.toLowerCase()];
    if (fn) fn();
    goPrefix = false;
    return;
  }

  if (event.key.toLowerCase() === "g") {
    goPrefix = true;
    setTimeout(() => (goPrefix = false), 1200);
    return;
  }

  if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    navigate("home");
    focusIntakeInput();
    return;
  }

  if (event.key === "Escape") {
    if (dismissTopmostOverlay()) {
      event.preventDefault();
    }
  }
});

initTargetSuggest();
onConnectionChange(updateConnectionStatus);
connectStateEvents(handleStateEvent);
render();
setupRailResize();
void refresh(["all"]);
