import { refreshMergeStates } from "../../core/tasks/merge-tracking.ts";
import type { AutonomyRunResult } from "../job-types.ts";

/**
 * Poll GitHub/GitLab for the real merge state of every open MR/PR raised by the
 * harness. Tickets complete only once the forge reports the MR/PR as merged; open
 * and closed-without-merge results are recorded so the homepage can tell them apart.
 */
export async function runMergeStatusSweep(root: string): Promise<AutonomyRunResult> {
  const result = await refreshMergeStates(root);

  if (!result.scanned) {
    return {
      jobId: "merge-status-sweep",
      status: "completed",
      summary: "No merge requests awaiting merge-state refresh.",
      proposalsCreated: 0
    };
  }

  const parts = [`Refreshed ${result.scanned} pending MR/PR(s)`];
  if (result.merged) parts.push(`${result.merged} merged`);
  if (result.open) parts.push(`${result.open} still open`);
  if (result.closed) parts.push(`${result.closed} closed unmerged`);
  if (result.unknown) parts.push(`${result.unknown} unknown`);

  return {
    jobId: "merge-status-sweep",
    status: "completed",
    summary: `${parts.join("; ")}.`,
    proposalsCreated: 0
  };
}
