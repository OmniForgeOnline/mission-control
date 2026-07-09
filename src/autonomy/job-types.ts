import path from "node:path";

export type AutonomyJobStatus = "active" | "paused";
export type AutonomyApprovalPolicy = "proposal-only" | "read-only" | "synthetic-task";
export type AutonomyRunMode = "manual" | "automatic";

export interface AutonomyJob {
  id: string;
  title: string;
  description: string;
  /** Cron-ish: "every-Nm" | "every-Nh" | "every-Nd" | "manual". */
  schedule: string;
  status: AutonomyJobStatus;
  runMode: AutonomyRunMode;
  approvalPolicy: AutonomyApprovalPolicy;
  /** Agent-turn prompt for custom jobs with no built-in handler. */
  instructions?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastSummary?: string;
}

export interface AutonomyRunResult {
  jobId: string;
  status: "completed" | "blocked";
  summary: string;
  proposalsCreated: number;
  syntheticTaskId?: string;
}

export const DEFAULT_JOBS: AutonomyJob[] = [
  {
    id: "worktree-cleanup-sweep",
    title: "Worktree cleanup sweep",
    description: "Remove isolated git worktrees after their merge requests have been merged.",
    schedule: "every-1h",
    status: "active",
    runMode: "automatic",
    approvalPolicy: "read-only"
  },
  {
    id: "merge-status-sweep",
    title: "Merge status sweep",
    description:
      "Poll GitHub/GitLab for the real merge state of open MRs/PRs and complete tickets only once merged.",
    schedule: "every-1h",
    status: "active",
    runMode: "automatic",
    approvalPolicy: "read-only"
  },
  {
    id: "workflow-reconcile-sweep",
    title: "Workflow reconcile sweep",
    description:
      "Scan repo-backed tasks stuck after push on pre-review workflow steps and chain workflow advancement.",
    schedule: "every-1h",
    status: "active",
    runMode: "automatic",
    approvalPolicy: "read-only"
  },
  {
    id: "clickup-ticket-sync",
    title: "ClickUp ticket sync",
    description: "Poll subscribed ClickUp lists for @omc tickets and mirror harness lifecycle updates upstream.",
    schedule: "every-5m",
    status: "paused",
    runMode: "automatic",
    approvalPolicy: "synthetic-task"
  }
];

export const STALE_GUIDANCE = [
  "Do not rely on a standalone gbrain CLI",
  "gbrain serve --http --port 8105",
  "Brain-first lookup chain"
];

export function jobsPath(root: string): string {
  return path.join(root, "data", "state", "autonomy-jobs.json");
}

export function techDebtPath(root: string): string {
  return path.join(root, "data", "state", "tech-debt.json");
}

export function autonomyRunsPath(root: string): string {
  return path.join(root, "data", "state", "autonomy-runs.json");
}

export function evolutionReviewedPath(root: string): string {
  return path.join(root, "data", "state", "evolution-reviewed.json");
}
