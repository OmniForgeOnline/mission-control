import path from "node:path";

import { readJsonFile, writeJsonFile, readTextFile } from "../infra/fs.ts";
import { getProject, projectDir, listProjects as listAllProjects } from "./registry.ts";
import type { ProjectRecord } from "./registry.ts";
import { nextRunFor, withDefaults, parseSchedule } from "../../autonomy/job-schedule.ts";
import type { AutonomyJob, AutonomyJobStatus, AutonomyRunMode } from "../../autonomy/job-types.ts";
import type { AutonomyJobContext, AutonomyJobHandler } from "../../autonomy/registry.ts";
import { markAutonomyJobRunning, clearAutonomyJobRunning } from "../../autonomy/runtime.ts";
import { runAutonomyAgentTurn } from "../../autonomy/agent-run.ts";
import { listTasks } from "../tasks/tasks.ts";
import { emitStateChange } from "../../core/infra/state-bus.ts";
import { runProjectQualityGateSweep } from "../../autonomy/handlers/project-quality.ts";
import { runProjectTechDebtSweep } from "../../autonomy/handlers/project-tech-debt-sweep.ts";
import { runProjectEvolutionReview } from "../../autonomy/handlers/project-evolution-review.ts";
import { runProjectSelfImprovement } from "../../autonomy/handlers/project-self-improvement.ts";
import { runProjectErrorTriage } from "../../autonomy/handlers/project-error-triage.ts";
import { runProjectMemoryIndexRefresh } from "../../autonomy/handlers/project-memory-index-refresh.ts";
import { runProjectDocGardening } from "../../autonomy/handlers/project-doc-gardening.ts";
import { runGuidanceSweep } from "../../autonomy/handlers/guidance-sweep.ts";
import { validateProjectJobDefinition, type ProjectJobDefinition } from "./job-schema.ts";
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

/**
 * The harness guidance sweep, expressed as a schema-valid project job
 * definition. This is the reference instance custom jobs are derived from and
 * validated against. It seeds only for the harness project (below), so a public
 * install no longer spends every user's tokens improving one repo.
 */
export const HARNESS_GUIDANCE_SWEEP_DEFINITION: ProjectJobDefinition = {
  id: "guidance-sweep",
  title: "Harness guidance sweep",
  description: "Compare this repo's kernel guidance against daemon behavior and draft proposals.",
  schedule: "every-1d",
  runMode: "manual",
  approvalPolicy: "proposal-only"
};

const HARNESS_GUIDANCE_SWEEP_DEFAULT_STATUS: AutonomyJobStatus = "paused";

/**
 * A project is "the harness project" when its repo *is* the mission-control
 * source (package name match). Only then does it own the guidance sweep.
 */
export async function isHarnessProject(project: ProjectRecord): Promise<boolean> {
  const raw = await readTextFile(path.join(project.repoPath, "package.json"));
  if (!raw) return false;
  try {
    const pkg = JSON.parse(raw) as { name?: unknown };
    return pkg.name === "@omniforge/mission-control";
  } catch {
    return false;
  }
}

/** Built-in defaults for a project: the generic set, plus harness-only jobs. */
async function applicableProjectJobDefaults(project: ProjectRecord): Promise<AutonomyJob[]> {
  if (await isHarnessProject(project)) {
    return [
      ...PROJECT_JOB_DEFAULTS,
      withDefaults({ ...HARNESS_GUIDANCE_SWEEP_DEFINITION, status: HARNESS_GUIDANCE_SWEEP_DEFAULT_STATUS })
    ];
  }
  return PROJECT_JOB_DEFAULTS;
}

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
  const defaults = await applicableProjectJobDefaults(project);

  // Stored jobs (defaults previously seeded + any custom jobs an operator/agent
  // defined) are preserved verbatim; only missing defaults are added.
  const byId = new Map<string, AutonomyJob>();
  for (const job of stored) byId.set(job.id, withDefaults(job));
  let changed = false;
  for (const def of defaults) {
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
  "doc-gardening": runProjectDocGardening,
  "guidance-sweep": runGuidanceSweep
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
      : job.instructions
        ? await runCustomProjectJob(root, project, job)
        : {
            jobId: jobName,
            status: "blocked" as const,
            summary: "Unknown project job: no handler or instructions",
            proposalsCreated: 0
          };

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

export type DefineProjectJobResult = { ok: true; job: AutonomyJob } | { ok: false; errors: string[] };

/**
 * Validate an agent/operator-authored job definition against the schema and, if
 * valid, register it for the project (offered in its job list). Custom jobs
 * (no built-in handler) must carry `instructions`. An existing job id is
 * updated in place; operator-set status and run history are preserved.
 */
export async function defineProjectJob(
  root: string,
  projectId: string,
  input: unknown
): Promise<DefineProjectJobResult> {
  const project = await getProject(root, projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const validation = validateProjectJobDefinition(input);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const definition = validation.job;

  const hasHandler = Object.prototype.hasOwnProperty.call(PROJECT_JOB_HANDLERS, definition.id);
  if (!hasHandler && !definition.instructions) {
    return { ok: false, errors: ["instructions is required for jobs without a built-in handler."] };
  }

  const filePath = projectJobsPath(root, projectId);
  const stored = await readJsonFile<AutonomyJob[]>(filePath, []);
  const existing = stored.find((j) => j.id === definition.id);
  const materialized: AutonomyJob = withDefaults({
    id: definition.id,
    title: definition.title,
    description: definition.description,
    schedule: definition.schedule,
    runMode: definition.runMode,
    approvalPolicy: definition.approvalPolicy,
    status: existing?.status ?? "active",
    ...(definition.instructions ? { instructions: definition.instructions } : {}),
    ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    ...(existing?.lastSummary ? { lastSummary: existing.lastSummary } : {})
  });

  const index = stored.findIndex((j) => j.id === definition.id);
  if (index >= 0) stored[index] = materialized;
  else stored.push(materialized);
  await writeJsonFile(filePath, stored);
  return { ok: true, job: materialized };
}

async function buildCustomProjectJobContext(root: string, project: ProjectRecord): Promise<string> {
  const tasks = (await listTasks(root)).filter(
    (t) => t.repoPath === project.repoPath || t.targets.some((tgt) => tgt.path.startsWith(project.repoPath))
  );
  const lines = tasks
    .slice(0, 8)
    .map((t) => `- ${t.id.slice(0, 8)} · ${t.resolution ?? (t.blockedReason ? "blocked" : "active")} · "${t.title}"`);
  return [
    `Project: ${project.name} (${project.repoPath})`,
    "",
    "Recent project tasks:",
    lines.length ? lines.join("\n") : "- none",
    "",
    "Investigate with list_tasks, read_task, list_runs, read_run, gbrain_search. File fixes via tech_debt_capture(projectId) or normal tasks. Do not edit project files directly."
  ].join("\n");
}

/** Run an agent-authored job (no built-in handler) as an agent turn. */
async function runCustomProjectJob(
  root: string,
  project: ProjectRecord,
  job: AutonomyJob
): Promise<AutonomyRunResult> {
  const context = await buildCustomProjectJobContext(root, project);
  const prompt = `${job.instructions}\n\n## Project context\n\n${context}`;
  const result = await runAutonomyAgentTurn(root, {
    taskId: `autonomy:project:${project.id}:${job.id}`,
    taskTitle: `${job.title}: ${project.name}`,
    projectId: project.id,
    repoPath: project.repoPath,
    stateFileName: `${project.id}/${job.id}.json`,
    skipSummary: `${job.title} skipped for ${project.name}: already running.`,
    completedSummary: (turnNumber, proposalsCreated) =>
      `${job.title} turn ${turnNumber} for ${project.name}; ${proposalsCreated} item(s).`,
    blockedSummary: (reason) => `${job.title} blocked for ${project.name}: ${reason}.`,
    buildContext: async () => prompt,
    buildPrompt: () => prompt
  });
  return {
    jobId: job.id,
    status: result.status,
    summary: result.summary,
    proposalsCreated: result.proposalsCreated
  };
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
