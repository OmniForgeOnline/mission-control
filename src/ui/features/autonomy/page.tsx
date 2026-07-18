import { useEffect, useRef } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { withPending } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { ui, relativeTime } from "@ui/app/state.js";
import { toast } from "@ui/overlays/toast.js";
import { bindTails } from "@ui/features/runs/tail.js";
import type { AutonomyJob } from "@ui/app/types.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function shortSchedule(schedule: string): string {
  const trimmed = schedule.trim();
  if (trimmed.startsWith("every-")) return trimmed;
  const parts = trimmed
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/** Scope of an autonomy panel: the global Mission Control jobs or a single project. */
export type AutonomyScope = { kind: "harness" } | { kind: "project"; projectId: string };

const CONNECTOR_OWNED_HARNESS_JOBS = new Set(["clickup-ticket-sync"]);

function jobsForScope(jobs: AutonomyJob[], scope: AutonomyScope): AutonomyJob[] {
  if (scope.kind === "harness") {
    return jobs.filter(
      (job) =>
        (job.scope === "harness" || !job.scope) && !CONNECTOR_OWNED_HARNESS_JOBS.has(job.id)
    );
  }
  return jobs.filter((job) => job.scope === "project" && job.scopeId === scope.projectId);
}

export function AutonomyJobRow({ job, scopeId }: { job: AutonomyJob; scopeId?: string }) {
  const lastLine = job.lastSummary ?? job.description;
  const when = job.lastRunAt ? relativeTime(job.lastRunAt) : "never";
  const canStop = Boolean(job.isRunning && job.activeRunId);
  const isProject = job.scope === "project" && scopeId;

  async function handleRunModeChange(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const runMode = input.checked ? "automatic" : "manual";
    if (isProject) {
      await api(`/api/projects/${scopeId}/jobs/${job.id}/run-mode`, {
        method: "POST",
        body: JSON.stringify({ runMode })
      });
    } else {
      await api(`/api/autonomy/jobs/${job.id}/run-mode`, {
        method: "POST",
        body: JSON.stringify({ runMode })
      });
    }
    document.dispatchEvent(new CustomEvent("harness:refresh"));
  }

  async function handleStatusChange(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const status = input.checked ? "active" : "paused";
    await api(`/api/autonomy/jobs/${job.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status })
    });
    document.dispatchEvent(new CustomEvent("harness:refresh"));
  }

  async function handleRunNow(): Promise<void> {
    document.dispatchEvent(new CustomEvent("harness:refresh"));
    try {
      let r: { summary: string } | null;
      if (isProject) {
        r = await api<{ summary: string }>(`/api/projects/${scopeId}/jobs/${job.id}/run`, {
          method: "POST"
        });
      } else {
        r = await api<{ summary: string }>(`/api/autonomy/jobs/${job.id}/run`, {
          method: "POST"
        });
      }
      if (r) toast(r.summary, { tone: "success" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Autonomy job failed.", { tone: "error" });
    } finally {
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    }
  }

  async function handleStop(): Promise<void> {
    if (!job.activeRunId) return;
    try {
      await api(`/api/runs/${job.activeRunId}/kill`, { method: "POST" });
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (error) {
      toast(error instanceof Error ? error.message : "Failed to stop job.", { tone: "error" });
    }
  }

  return (
    <div
      class="autonomy-row"
      data-tone={job.isRunning ? "running" : undefined}
      aria-busy={job.isRunning ? "true" : undefined}
      data-autonomy-row={job.id}
    >
      <div class="autonomy-job">
        {job.isRunning ? <span class="autonomy-live-dot" aria-hidden="true" /> : null}
        <span class="autonomy-title" title={job.description}>
          {job.title}
        </span>
        <span class="autonomy-policy chip">{job.approvalPolicy.replace(/-/g, " ")}</span>
      </div>
      <div class="autonomy-schedule chip mono" title={job.schedule}>
        {shortSchedule(job.schedule)}
      </div>
      <div class="autonomy-summary" title={lastLine}>
        {lastLine}
      </div>
      <div class="autonomy-when">{when}</div>
      <div class="autonomy-actions">
        {job.isRunning ? <div class="autonomy-progress" aria-hidden="true" /> : null}
        {!isProject ? (
          <label class="autonomy-active" title="Activate or pause this job">
            <input
              type="checkbox"
              data-status={job.id}
              checked={job.status === "active"}
              disabled={job.isRunning}
              onChange={(e) => void handleStatusChange(e)}
            />
            <span>Active</span>
          </label>
        ) : null}
        <label class="autonomy-auto" title="Run automatically on schedule">
          <input
            type="checkbox"
            data-automatic={job.id}
            checked={job.runMode === "automatic"}
            disabled={job.isRunning}
            onChange={(e) => void handleRunModeChange(e)}
          />
          <span>Auto</span>
        </label>
        {job.isRunning ? (
          <>
            {job.activeRunId ? (
              <button
                class="btn btn-sm btn-ghost"
                type="button"
                data-tail={job.activeRunId}
                data-title={job.title}
                title="Live tail"
                aria-label="Live tail"
              >
                <Icon name="terminal" size={12} />
              </button>
            ) : null}
            <button
              class="btn btn-sm btn-danger autonomy-stop"
              type="button"
              data-stop-job={job.id}
              title={canStop ? "Stop" : "Job is running"}
              aria-label={canStop ? "Stop job" : "Job is running"}
              disabled={!canStop}
              onClick={() => void handleStop()}
            >
              <Icon name="square" size={12} />
            </button>
          </>
        ) : (
          <button
            class="btn btn-sm btn-ghost"
            type="button"
            data-run-job={job.id}
            title="Run now"
            aria-label="Run now"
            onClick={(e) => void withPending(e.currentTarget as HTMLButtonElement, handleRunNow)}
          >
            <Icon name="play" size={12} />
          </button>
        )}
      </div>
      {job.isRunning && job.activeRunId ? (
        <div class="autonomy-tail-host" data-tail-host={job.activeRunId} />
      ) : null}
    </div>
  );
}

/**
 * Autonomy jobs for a single scope. The built-in Mission Control project shows
 * the global jobs; a real project shows only its own scoped jobs.
 */
export function AutonomyPanel({ scope }: { scope: AutonomyScope }) {
  const jobs = jobsForScope(ui.data?.autonomyJobs ?? [], scope);
  const panelRef = useRef<HTMLDivElement>(null);
  const projectScopeId = scope.kind === "project" ? scope.projectId : undefined;

  useEffect(() => {
    if (panelRef.current) bindTails(panelRef.current);
  });

  return (
    <section class="project-panel project-panel-autonomy">
      <div class="project-section-head">
        <div>
          <h2>Autonomy</h2>
          <span class="muted">
            Background jobs. Toggle Active to enable a job and Auto to run it on schedule.
          </span>
        </div>
      </div>
      {jobs.length ? (
        <div class="autonomy-panel" ref={panelRef}>
          <div class="autonomy-head" aria-hidden="true">
            <span>Job</span>
            <span>Schedule</span>
            <span>Last run</span>
            <span>When</span>
            <span>Controls</span>
          </div>
          {jobs.map((job) => (
            <AutonomyJobRow
              key={job.id}
              job={job}
              {...(projectScopeId ? { scopeId: projectScopeId } : {})}
            />
          ))}
        </div>
      ) : (
        <div class="empty-state">No autonomy jobs configured.</div>
      )}
    </section>
  );
}
