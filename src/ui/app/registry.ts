import type { ViewName } from "./state.js";
import type { StateScope } from "./scopes.js";
import { includesScope, includesTaskScope, includesTaskActivityScope } from "./scopes.js";
import { ui } from "./state.js";
import { renderHomeView, updateHomeView } from "@ui/features/home/page.js";
import { renderProjectView, updateProjectView } from "@ui/features/projects/page.js";
import { renderTasksView, updateTasksView } from "@ui/features/tasks/page.js";
import {
  renderTaskDetail,
  updateTaskDetailView,
  updateTaskActivityView
} from "@ui/features/tasks/detail/page.js";
import { renderConnectorsView } from "@ui/features/connectors/page.js";
import { renderSettingsView } from "@ui/features/settings/page.js";
import { renderSkillsView } from "@ui/features/skills/page.js";
import { renderWorkflowsView } from "@ui/features/workflows/page.js";
import { renderSystemView } from "@ui/features/system/page.js";

export type ViewScopeHandler = (scopes: StateScope[]) => void;

export interface ViewRegistryEntry {
  render: () => void | Promise<void>;
  applyScopes?: ViewScopeHandler;
}

export const VIEW_REGISTRY: Record<ViewName, ViewRegistryEntry> = {
  home: {
    render: renderHomeView,
    applyScopes: (scopes) => {
      if (includesScope(scopes, "intake")) updateHomeView();
    }
  },
  project: {
    render: renderProjectView,
    applyScopes: (scopes) => {
      if (
        includesScope(scopes, "tasks") ||
        includesScope(scopes, "intake") ||
        includesScope(scopes, "runs") ||
        includesScope(scopes, "autonomy") ||
        includesScope(scopes, "memory")
      ) {
        updateProjectView();
      }
    }
  },
  tasks: {
    render: renderTasksView,
    applyScopes: (scopes) => {
      if (includesScope(scopes, "tasks")) updateTasksView();
    }
  },
  task: {
    render: renderTaskDetail,
    applyScopes: (scopes) => {
      if (includesTaskScope(scopes, ui.taskId)) updateTaskDetailView();
      else if (includesTaskActivityScope(scopes, ui.taskId)) updateTaskActivityView();
    }
  },
  skills: {
    render: () => void renderSkillsView()
  },
  connectors: {
    render: renderConnectorsView,
    applyScopes: (scopes) => {
      if (includesScope(scopes, "settings") || includesScope(scopes, "connectors")) {
        renderConnectorsView();
      }
    }
  },
  workflows: {
    render: () => void renderWorkflowsView()
  },
  maintenance: {
    render: renderSystemView,
    applyScopes: (scopes) => {
      if (includesScope(scopes, "autonomy") || includesScope(scopes, "runs")) {
        renderSystemView();
      }
    }
  },
  settings: {
    render: renderSettingsView,
    applyScopes: (scopes) => {
      if (includesScope(scopes, "settings")) renderSettingsView();
    }
  }
};
