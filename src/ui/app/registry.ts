import type { ViewName } from "./state.js";
import type { StateScope } from "./scopes.js";
import { includesScope, includesTaskScope, includesTaskActivityScope } from "./scopes.js";
import { ui } from "./state.js";

export type ViewScopeHandler = (scopes: StateScope[]) => void;

export interface ViewRegistryEntry {
  render: () => void | Promise<void>;
  applyScopes?: ViewScopeHandler;
}

/**
 * Route modules load on first visit so the initial shell stays small.
 * `import()` is cached by the browser/module graph after the first load.
 */
export const VIEW_REGISTRY: Record<ViewName, ViewRegistryEntry> = {
  home: {
    render: async () => {
      const { renderHomeView } = await import("@ui/features/home/page.js");
      return renderHomeView();
    },
    applyScopes: (scopes) => {
      if (includesScope(scopes, "intake")) {
        void import("@ui/features/home/page.js").then((m) => m.updateHomeView());
      }
    }
  },
  project: {
    render: async () => {
      const { renderProjectView } = await import("@ui/features/projects/page.js");
      return renderProjectView();
    },
    applyScopes: (scopes) => {
      if (
        includesScope(scopes, "tasks") ||
        includesScope(scopes, "intake") ||
        includesScope(scopes, "runs") ||
        includesScope(scopes, "autonomy") ||
        includesScope(scopes, "memory")
      ) {
        void import("@ui/features/projects/page.js").then((m) => m.updateProjectView());
      }
    }
  },
  tasks: {
    render: async () => {
      const { renderTasksView } = await import("@ui/features/tasks/page.js");
      return renderTasksView();
    },
    applyScopes: (scopes) => {
      if (includesScope(scopes, "tasks")) {
        void import("@ui/features/tasks/page.js").then((m) => m.updateTasksView());
      }
    }
  },
  task: {
    render: async () => {
      const { renderTaskDetail } = await import("@ui/features/tasks/detail/page.js");
      return renderTaskDetail();
    },
    applyScopes: (scopes) => {
      if (includesTaskScope(scopes, ui.taskId)) {
        void import("@ui/features/tasks/detail/page.js").then((m) => m.updateTaskDetailView());
      } else if (includesTaskActivityScope(scopes, ui.taskId)) {
        void import("@ui/features/tasks/detail/page.js").then((m) => m.updateTaskActivityView());
      }
    }
  },
  skills: {
    render: async () => {
      const { renderSettingsView } = await import("@ui/features/settings/page.js");
      ui.settingsSection = "skills";
      return renderSettingsView();
    }
  },
  connectors: {
    render: async () => {
      const { renderSettingsView } = await import("@ui/features/settings/page.js");
      ui.settingsSection = "connectors";
      return renderSettingsView();
    },
    applyScopes: (scopes) => {
      if (includesScope(scopes, "settings") || includesScope(scopes, "connectors")) {
        void import("@ui/features/settings/page.js").then((m) => m.renderSettingsView());
      }
    }
  },
  workflows: {
    render: async () => {
      const { renderSettingsView } = await import("@ui/features/settings/page.js");
      ui.settingsSection = "workflows";
      return renderSettingsView();
    }
  },
  maintenance: {
    render: async () => {
      const { renderSettingsView } = await import("@ui/features/settings/page.js");
      ui.settingsSection = "maintenance";
      return renderSettingsView();
    },
    applyScopes: (scopes) => {
      if (includesScope(scopes, "autonomy") || includesScope(scopes, "runs") || includesScope(scopes, "settings")) {
        void import("@ui/features/settings/page.js").then((m) => m.renderSettingsView());
      }
    }
  },
  settings: {
    render: async () => {
      const { renderSettingsView } = await import("@ui/features/settings/page.js");
      return renderSettingsView();
    },
    applyScopes: (scopes) => {
      if (
        includesScope(scopes, "settings") ||
        includesScope(scopes, "connectors") ||
        includesScope(scopes, "autonomy") ||
        includesScope(scopes, "runs")
      ) {
        void import("@ui/features/settings/page.js").then((m) => m.renderSettingsView());
      }
    }
  }
};
