import { render } from "preact";
import { $ } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { ui } from "@ui/app/state.js";
import { AutonomyPanel } from "@ui/features/autonomy/page.js";
import { RunGroupList } from "@ui/features/runs/page.js";
import { isMaintenanceRun } from "@ui/features/runs/groups.js";
import { confirmAndShutdown } from "./shutdown.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

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
      <PowerControl />
    </div>
  );
}

/**
 * Danger zone: stop the daemon from the UI. Shutdown is gated behind a
 * confirmation modal (see SHUTDOWN_WARNING) and then routed through the same
 * backend path as Ctrl+C and `mission-control stop`. After it succeeds the
 * server tears itself down, so the UI goes offline until a terminal restart.
 */
function PowerControl() {
  async function handleShutdown(event: Event): Promise<void> {
    // Confirm-gated, cancel-safe, duplicate-guarded shutdown shared with the
    // app-bar power button (see confirmAndShutdown).
    await confirmAndShutdown(event.currentTarget as HTMLButtonElement);
  }

  return (
    <section class="project-panel shutdown-panel">
      <div class="project-section-head">
        <div>
          <h2>Power</h2>
          <span class="muted">Stop the daemon and take the UI offline until a terminal restart.</span>
        </div>
      </div>
      <div class="shutdown-control">
        <button
          type="button"
          class="btn btn-danger"
          data-shutdown=""
          aria-label="Shut down Mission Control"
          onClick={handleShutdown}
        >
          <Icon name="power" /> Shut down Mission Control
        </button>
        <p class="shutdown-hint">
          This terminates every running process. You can also stop from the terminal with{" "}
          <code>mission-control stop</code>.
        </p>
      </div>
    </section>
  );
}

export function renderSystemView(): void {
  const root = $("#viewContent");
  if (!root) return;
  render(<MaintenanceView />, root);
}
