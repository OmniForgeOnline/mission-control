import { render } from "preact";
import { $ } from "@ui/shell/dom.js";
import { ui } from "@ui/app/state.js";
import { AutonomyPanel } from "@ui/features/autonomy/page.js";
import { RunGroupList } from "@ui/features/runs/page.js";
import { isMaintenanceRun } from "@ui/features/runs/groups.js";

/**
 * System → Maintenance. Surfaces the daemon-wide background jobs (doc
 * gardening, guidance sweep, worktree cleanup, workflow reconcile, ClickUp
 * sync, memory index refresh) and their run history. These are cross-cutting
 * infrastructure with no owning project, so they live here rather than in any
 * project's tabs.
 */
export function MaintenanceView() {
  const runs = (ui.data?.runs ?? []).filter(isMaintenanceRun);
  const runLabel = runs.length === 1 ? "run" : "runs";

  return (
    <div class="view" id="maintenanceView">
      <div class="view-header">
        <div>
          <h1 class="view-title">Maintenance</h1>
          <p class="view-subtitle">
            Daemon-wide background jobs that keep the harness healthy across every project.
          </p>
        </div>
      </div>
      <AutonomyPanel scope={{ kind: "harness" }} />
      <section class="project-panel">
        <div class="project-section-head">
          <div>
            <h2>Maintenance runs</h2>
            <span class="muted">
              {runs.length} {runLabel} from background jobs.
            </span>
          </div>
        </div>
        {runs.length === 0 ? (
          <div class="empty-state">No maintenance runs yet.</div>
        ) : (
          <RunGroupList runs={runs} />
        )}
      </section>
    </div>
  );
}

export function renderSystemView(): void {
  const root = $("#viewContent");
  if (!root) return;
  render(<MaintenanceView />, root);
}
