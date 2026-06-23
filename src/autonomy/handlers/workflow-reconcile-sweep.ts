import { reconcileStuckPushedTasks } from "../../core/bootstrap/reconciliation.ts";
import type { AutonomyRunResult } from "../job-types.ts";

export async function runWorkflowReconcileSweep(root: string): Promise<AutonomyRunResult> {
  const result = await reconcileStuckPushedTasks(root);

  if (!result.scanned) {
    return {
      jobId: "workflow-reconcile-sweep",
      status: "completed",
      summary: "No stuck pushed tasks on pre-review workflow steps.",
      proposalsCreated: 0
    };
  }

  const parts = [`Checked ${result.scanned} stuck pushed task(s)`];
  if (result.reconciled) {
    parts.push(`chained ${result.reconciled}`);
  }
  if (result.errors) {
    parts.push(`${result.errors} error(s)`);
  }

  return {
    jobId: "workflow-reconcile-sweep",
    status: result.errors > 0 && !result.reconciled ? "blocked" : "completed",
    summary: `${parts.join("; ")}.`,
    proposalsCreated: 0
  };
}