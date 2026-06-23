import { runHarnessGuidanceSweep } from "../guidance-sweep.ts";
import type { AutonomyRunResult } from "../job-types.ts";

export async function runGuidanceSweep(root: string): Promise<AutonomyRunResult> {
  const result = await runHarnessGuidanceSweep(root);
  return {
    jobId: "harness-guidance-sweep",
    status: result.status,
    summary: result.summary,
    proposalsCreated: result.proposalsCreated
  };
}