import { cleanupMergedTaskWorktrees } from "../../core/worktrees/lifecycle.ts";
import { listTasks } from "../../core/tasks/tasks.ts";
import type { AutonomyRunResult } from "../job-types.ts";

export async function runWorktreeCleanupSweep(root: string): Promise<AutonomyRunResult> {
  const tasks = await listTasks(root);
  const results = await cleanupMergedTaskWorktrees(root, tasks);
  const cleaned = results.filter((result) => result.cleaned).length;
  if (!results.length) {
    return {
      jobId: "worktree-cleanup-sweep",
      status: "completed",
      summary: "No worktrees on disk need cleanup.",
      proposalsCreated: 0
    };
  }
  if (!cleaned) {
    return {
      jobId: "worktree-cleanup-sweep",
      status: "completed",
      summary: `Checked ${results.length} worktree(s); none eligible for removal yet.`,
      proposalsCreated: 0
    };
  }
  return {
    jobId: "worktree-cleanup-sweep",
    status: "completed",
    summary: `Checked ${results.length} worktree(s); removed ${cleaned}.`,
    proposalsCreated: 0
  };
}