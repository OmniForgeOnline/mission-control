import type { AutonomyRunResult } from "./job-types.ts";
import type { ProjectRecord } from "../core/projects/registry.ts";
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
 * and have no per-project equivalent. The harness guidance sweep is no longer
 * global: it is a project-scoped job owned by the harness project itself (see
 * scoped-autonomy.ts). Project-domain autonomy (quality, tech debt, evolution
 * review, self-improvement, error triage) likewise runs per-project.
 */
export const AUTONOMY_JOB_HANDLERS: Record<string, AutonomyJobHandler> = {
  "merge-status-sweep": runMergeStatusSweep,
  "worktree-cleanup-sweep": runWorktreeCleanupSweep,
  "workflow-reconcile-sweep": runWorkflowReconcileSweep,
  "clickup-ticket-sync": runClickUpTicketSync
};
