import path from "node:path";

import { readJsonFile, writeJsonFile, ensureDir } from "../infra/fs.ts";
import { getProject, projectDir, listProjects as listAllProjects } from "./registry.ts";
import { nextRunFor, withDefaults, parseSchedule } from "../../autonomy/job-schedule.ts";
import type { AutonomyJob, AutonomyRunMode } from "../../autonomy/job-types.ts";
import type { AutonomyJobContext, AutonomyJobHandler } from "../../autonomy/registry.ts";
import { markAutonomyJobRunning, clearAutonomyJobRunning } from "../../autonomy/runtime.ts";
import { emitStateChange } from "../../core/infra/state-bus.ts";
import { runProjectQualityGateSweep } from "../../autonomy/handlers/project-quality.ts";
import { runProjectTechDebtSweep } from "../../autonomy/handlers/project-tech-debt-sweep.ts";
import { runProjectEvolutionReview } from "../../autonomy/handlers/project-evolution-review.ts";
import { runProjectSelfImprovement } from "../../autonomy/handlers/project-self-improvement.ts";
import { runProjectErrorTriage } from "../../autonomy/handlers/project-error-triage.ts";
import { runProjectMemoryIndexRefresh } from "../../autonomy/handlers/project-memory-index-refresh.ts";
import { runProjectDocGardening } from "../../autonomy/handlers/project-doc-gardening.ts";
import { autonomyRunsPath } from "../../autonomy/job-types.ts";
import type { AutonomyRunResult } from "../../autonomy/job-types.ts";

export const PROJECT_JOB_DEFAULTS: AutonomyJob[] = [
  {
    id: "quality-gate-sweep",
    title: "Quality gate sweep",
    description: "Queue synthetic remediation for failing quality-gate checks from the last run.",
    schedule: "every-1d",
    status: "active",
    runMode: "manual",
    approvalPolicy: "synthetic-task"
  },
  {
    id: "tech-debt-sweep",
    title: "Tech debt sweep",
    description: "Walk project tech-debt.json and queue a synthetic task per item.",
    schedule: "every-2d",
    status: "active",
    runMode: "manual",
    approvalPolicy: "synthetic-task"
  },
  {
    id: "turn-evolution-review",
    title: "Turn evolution review",
    description: "Find cross-run patterns in recent project runs and capture tech debt.",
    schedule: "every-6h",
    status: "active",
    runMode: "manual",
    approvalPolicy: "proposal-only"
  },
  {
    id: "project-self-improvement",
    title: "Project self-improvement",
    description: "Review recent project operation and draft improvement tasks.",
    schedule: "every-1d",
    status: "active",
    runMode: "manual",
    approvalPolicy: "synthetic-task"
  },
  {
    id: "project-operational-triage",
    title: "Project operational triage",
    description: "Analyze recurring project task failures and capture tech debt.",
    schedule: "every-2h",
    status: "active",
    runMode: "manual",
    approvalPolicy: "synthetic-task"
  },
  {
    id: "memory-index-refresh",
    title: "Memory index refresh",
    description: "Rebuild the project's gbrain search index (wiki pages, tasks, runs, run logs, target files).",
    schedule: "every-1h",
    status: "active",
    runMode: "manual",
    approvalPolicy: "read-only"
  },
  {
    id: "doc-gardening",
    title: "Documentation gardening",
    description: "Find documentation drift in the project's own docs and memory pages and capture fix-ups.",
    schedule: "every-1d",
    status: "active",
    runMode: "manual",
    approvalPolicy: "proposal-only"
  }
];

function projectJobsPath(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), "autonomy-jobs.json");
}

export function scopedJobId(projectId: string, jobName: string): string {
  return `project:${projectId}:${jobName}`;
}

export async function listProjectJobs(root: string, projectId: string): Promise<AutonomyJob[]> {
  const project = await getProject(root, projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const filePath = projectJobsPath(root, projectId);
  const stored = await readJsonFile<AutonomyJob[]>(filePath, []);
  if (!stored.length) {
    const seeded = PROJECT_JOB_DEFAULTS.map(withDefaults);
    await ensureDir(path.dirname(filePath));
    await writeJsonFile(filePath, seeded);
    return seeded;
  }
  // Merge with defaults (same pattern as harness jobs)
  const byId = new Map(stored.map((job) => [job.id, withDefaults(job)] as const));
  let changed = stored.length !== PROJECT_JOB_DEFAULTS.length;
  for (const def of PROJECT_JOB_DEFAULTS) {
    if (!byId.has(def.id)) {
      byId.set(def.id, withDefaults(def));
      changed = true;
    }
  }
  const merged = [...byId.values()];
  if (changed) {
    await writeJsonFile(filePath, merged);
  }
  return merged;
}

export async function setProjectJobRunMode(
  root: string,
  projectId: string,
  jobName: string,
  runMode: AutonomyRunMode
): Promise<AutonomyJob> {
  if (runMode !== "manual" && runMode !== "automatic") {
    throw new Error("runMode must be manual or automatic.");
  }
  const jobs = await listProjectJobs(root, projectId);
  const index = jobs.findIndex((j) => j.id === jobName);
  if (index === -1) {
    throw new Error(`Job not found: ${jobName}`);
  }
  jobs[index] = { ...jobs[index]!, runMode };
  await writeJsonFile(projectJobsPath(root, projectId), jobs);
  return jobs[index]!;
}

const PROJECT_JOB_HANDLERS: Record<string, AutonomyJobHandler> = {
  "quality-gate-sweep": runProjectQualityGateSweep,
  "tech-debt-sweep": runProjectTechDebtSweep,
  "turn-evolution-review": runProjectEvolutionReview,
  "project-self-improvement": runProjectSelfImprovement,
  "project-operational-triage": runProjectErrorTriage,
  "memory-index-refresh": runProjectMemoryIndexRefresh,
  "doc-gardening": runProjectDocGardening
};

export async function runProjectJob(
  root: string,
  projectId: string,
  jobName: string
): Promise<AutonomyRunResult> {
  const project = await getProject(root, projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (project.status !== "active") throw new Error(`Project is not active: ${projectId}`);

  const jobs = await listProjectJobs(root, projectId);
  const job = jobs.find((j) => j.id === jobName);
  if (!job) throw new Error(`Job not found: ${jobName}`);
  if (job.status !== "active") throw new Error(`Job is not active: ${jobName}`);

  const compositeId = scopedJobId(projectId, jobName);
  markAutonomyJobRunning(compositeId);
  emitStateChange(["autonomy"]);
  try {
    const handler = PROJECT_JOB_HANDLERS[jobName];
    const context: AutonomyJobContext = { project };
    const result = handler
      ? await handler(root, context)
      : { jobId: jobName, status: "blocked" as const, summary: "Unknown project job", proposalsCreated: 0 };

    // Update job run metadata
    const updatedJobs = await listProjectJobs(root, projectId);
    const nowISO = new Date().toISOString();
    const nextJobs = updatedJobs.map((j) =>
      j.id === jobName
        ? {
            ...j,
            lastRunAt: nowISO,
            lastSummary: result.summary,
            nextRunAt: nextRunFor(j.schedule, nowISO)
          }
        : j
    );
    await writeJsonFile(projectJobsPath(root, projectId), nextJobs);

    // Append to harness-wide run history
    const history = await readJsonFile<AutonomyRunResult[]>(autonomyRunsPath(root), []);
    history.unshift({ ...result, jobId: compositeId });
    await writeJsonFile(autonomyRunsPath(root), history.slice(0, 200));

    return result;
  } finally {
    clearAutonomyJobRunning(compositeId);
    emitStateChange(["autonomy"]);
  }
}

export async function pickDueProjectJob(
  root: string
): Promise<{ projectId: string; jobName: string } | null> {
  const projects = await listAllProjects(root);
  for (const project of projects) {
    if (project.status !== "active") continue;
    const jobs = await listProjectJobs(root, project.id);
    for (const job of jobs) {
      if (job.status !== "active" || job.runMode !== "automatic") continue;
      if (!job.nextRunAt) {
        if (parseSchedule(job.schedule) !== null) return { projectId: project.id, jobName: job.id };
        continue;
      }
      if (Date.parse(job.nextRunAt) <= Date.now()) {
        return { projectId: project.id, jobName: job.id };
      }
    }
  }
  return null;
}
