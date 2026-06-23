import type { AutonomyRunResult } from "./job-types.ts";
import type { ProjectRecord } from "../core/projects/registry.ts";
import { runGuidanceSweep } from "./handlers/guidance-sweep.ts";
import { runMergeStatusSweep } from "./handlers/merge-status-sweep.ts";
import { runWorktreeCleanupSweep } from "./handlers/worktree-cleanup.ts";
import { runWorkflowReconcileSweep } from "./handlers/workflow-reconcile-sweep.ts";
import { runClickUpTicketSync } from "./handlers/clickup-ticket-sync.ts";

export interface AutonomyJobContext {
  project?: ProjectRecord;
}

export type AutonomyJobHandler = (
  root: string,
  context?: AutonomyJobContext
) => Promise<AutonomyRunResult>;

/**
 * Cross-cutting daemon-maintenance jobs that operate on harness-wide resources
 * and have no per-project equivalent. Project-domain autonomy (quality, tech
 * debt, evolution review, self-improvement, error triage) runs per-project via
 * scoped-autonomy.ts.
 */
export const AUTONOMY_JOB_HANDLERS: Record<string, AutonomyJobHandler> = {
  "harness-guidance-sweep": runGuidanceSweep,
  "merge-status-sweep": runMergeStatusSweep,
  "worktree-cleanup-sweep": runWorktreeCleanupSweep,
  "workflow-reconcile-sweep": runWorkflowReconcileSweep,
  "clickup-ticket-sync": runClickUpTicketSync
};
