import { pickDueAutomaticJob, runAutonomyJob } from "../autonomy/jobs.ts";
import { reconcileStuckPushedTasks } from "../core/bootstrap/reconciliation.ts";
import { reconcileStaleQualityGates } from "../core/projects/quality-gate-generation.ts";
import { processAllApprovedTasks } from "./processor.ts";
import { pickDueProjectJob, runProjectJob } from "../core/projects/scoped-autonomy.ts";

export interface DaemonHandle {
  /** Stop the loop. Idempotent. Resolves once the in-flight tick completes. */
  stop(): Promise<void>;
}

export interface DaemonOptions {
  root: string;
  intervalMs?: number;
  autonomy?: boolean;
  /**
   * Optional logger. Default: console.log. Set to () => {} to silence the loop
   * (useful when the server already logs lifecycle events).
   */
  log?: (message: string) => void;
  /** Surface unexpected errors. Default: console.error. */
  onError?: (error: unknown) => void;
}

/**
 * Start a non-blocking task + autonomy loop for the given harness root.
 * Returns a handle that stops the loop and waits for the in-flight tick to
 * settle so Ctrl+C never tears the daemon mid-tick.
 */
export function startDaemonLoop(options: DaemonOptions): DaemonHandle {
  const interval = options.intervalMs ?? 5_000;
  const log = options.log ?? ((message: string) => console.log(message));
  const onError = options.onError ?? ((err: unknown) => console.error(err));

  let stopped = false;
  let inflightTick: Promise<void> = Promise.resolve();

  async function tickReconciliation(): Promise<void> {
    if (stopped) return;
    try {
      const result = await reconcileStuckPushedTasks(options.root);
      if (result.reconciled > 0) {
        log(`daemon: reconciled ${result.reconciled} stuck pushed task(s)`);
      }
    } catch (error) {
      onError(error);
    }
  }

  async function tickQualityGateRecovery(): Promise<void> {
    if (stopped) return;
    try {
      const recovered = await reconcileStaleQualityGates(options.root);
      if (recovered > 0) {
        log(`daemon: re-kicked ${recovered} stale quality-gate generation(s)`);
      }
    } catch (error) {
      onError(error);
    }
  }

  async function tickTasks(): Promise<void> {
    if (stopped) return;
    try {
      const launched = await processAllApprovedTasks(options.root);
      for (const result of launched) {
        log(`daemon: ran turn -> run ${result.runId} (${result.execution})`);
      }
    } catch (error) {
      onError(error);
    }
  }

  async function tickAutonomy(): Promise<void> {
    if (stopped) return;
    if (options.autonomy === false) return;
    try {
      // Daemon-maintenance jobs (cross-cutting infra) run first.
      const harnessJob = await pickDueAutomaticJob(options.root);
      if (harnessJob) {
        const result = await runAutonomyJob(options.root, harnessJob.id);
        log(`daemon: maintenance ${harnessJob.id} -> ${result.status} (${result.summary})`);
        return;
      }
      // Then per-project scoped jobs.
      const projectJob = await pickDueProjectJob(options.root);
      if (projectJob) {
        const result = await runProjectJob(options.root, projectJob.projectId, projectJob.jobName);
        log(`daemon: project:${projectJob.projectId}:${projectJob.jobName} -> ${result.status} (${result.summary})`);
        return;
      }
    } catch (error) {
      onError(error);
    }
  }

  function tick(): Promise<void> {
    inflightTick = (async () => {
      await tickReconciliation();
      await tickQualityGateRecovery();
      await tickTasks();
      await tickAutonomy();
    })();
    return inflightTick;
  }

  // Fire once immediately so a freshly started server doesn't wait `interval`
  // ms before processing approved tasks. Don't await — the server boot must
  // not block on this.
  void tick();
  const handle = setInterval(() => void tick(), interval);
  // Don't keep the event loop alive purely for the loop. We always have the
  // http server keeping it alive when this is in-process; for the standalone
  // daemon, SIGINT clears the interval.
  if (typeof handle === "object" && "unref" in (handle as object)) {
    (handle as { unref?: () => void }).unref?.();
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      await inflightTick.catch(() => {/* ignore */});
    }
  };
}
