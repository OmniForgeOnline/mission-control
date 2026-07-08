import { ensureHarnessRepository } from "../core/bootstrap/repository.ts";
import { emitStateChange } from "../core/infra/state-bus.ts";
import { readJsonFile, writeJsonFile } from "../core/infra/fs.ts";
import {
  DEFAULT_JOBS,
  autonomyRunsPath,
  jobsPath,
  type AutonomyJob,
  type AutonomyJobStatus,
  type AutonomyRunMode,
  type AutonomyRunResult
} from "./job-types.ts";
import { now, nextRunFor, parseSchedule, withDefaults } from "./job-schedule.ts";
import { clearAutonomyJobRunning, markAutonomyJobRunning } from "./runtime.ts";
import { AUTONOMY_JOB_HANDLERS } from "./registry.ts";

export type { AutonomyJob, AutonomyJobStatus, AutonomyRunMode, AutonomyRunResult } from "./job-types.ts";

export async function listAutonomyJobs(root: string): Promise<AutonomyJob[]> {
  await ensureHarnessRepository(root);
  const stored = await readJsonFile<AutonomyJob[]>(jobsPath(root), []);
  if (!stored.length) {
    const seeded = DEFAULT_JOBS.map(withDefaults);
    await writeJsonFile(jobsPath(root), seeded);
    return seeded;
  }
  const byId = new Map(stored.map((job) => [job.id, withDefaults(job)] as const));
  const defaultIds = new Set(DEFAULT_JOBS.map((def) => def.id));
  let changed = stored.length !== DEFAULT_JOBS.length;
  // Prune stored globals that are no longer maintenance defaults (e.g. jobs
  // reclassified to per-project scope). Without this they linger in the
  // Maintenance view with no handler.
  for (const id of [...byId.keys()]) {
    if (!defaultIds.has(id)) {
      byId.delete(id);
      changed = true;
    }
  }
  for (const def of DEFAULT_JOBS) {
    const existing = byId.get(def.id);
    if (!existing) {
      byId.set(def.id, withDefaults(def));
      changed = true;
      continue;
    }
    let next = existing;
    if (existing.title !== def.title || existing.description !== def.description) {
      next = { ...next, title: def.title, description: def.description };
      changed = true;
    }
    if (def.id === "clickup-ticket-sync" && shouldMigrateClickUpSyncJob(existing, def)) {
      // Status is an operator choice (active/paused), not a shipped default:
      // migrate config shape only, never clobber a deliberate activation.
      next = {
        ...next,
        schedule: def.schedule,
        runMode: def.runMode,
        approvalPolicy: def.approvalPolicy
      };
      changed = true;
    }
    if (next !== existing) {
      byId.set(def.id, withDefaults(next));
    }
  }
  const merged = [...byId.values()];
  if (changed) {
    await writeJsonFile(jobsPath(root), merged);
  }
  return merged;
}

function shouldMigrateClickUpSyncJob(existing: AutonomyJob, def: AutonomyJob): boolean {
  return (
    existing.schedule !== def.schedule ||
    existing.runMode !== def.runMode ||
    existing.approvalPolicy !== def.approvalPolicy
  );
}

export async function setAutonomyJobRunMode(
  root: string,
  jobId: string,
  runMode: AutonomyRunMode
): Promise<AutonomyJob> {
  if (runMode !== "manual" && runMode !== "automatic") {
    throw new Error("Autonomy job runMode must be manual or automatic.");
  }
  const jobs = await listAutonomyJobs(root);
  const index = jobs.findIndex((job) => job.id === jobId);
  if (index === -1) throw new Error(`Autonomy job not found: ${jobId}`);
  const updated = { ...jobs[index]!, runMode };
  jobs[index] = updated;
  await writeJsonFile(jobsPath(root), jobs);
  return updated;
}

export async function setAutonomyJobStatus(
  root: string,
  jobId: string,
  status: AutonomyJobStatus
): Promise<AutonomyJob> {
  if (status !== "active" && status !== "paused") {
    throw new Error("Autonomy job status must be active or paused.");
  }
  const jobs = await listAutonomyJobs(root);
  const index = jobs.findIndex((job) => job.id === jobId);
  if (index === -1) throw new Error(`Autonomy job not found: ${jobId}`);
  const updated = { ...jobs[index]!, status };
  jobs[index] = updated;
  await writeJsonFile(jobsPath(root), jobs);
  return updated;
}

export async function runAutonomyJob(root: string, jobId: string): Promise<AutonomyRunResult> {
  const jobs = await listAutonomyJobs(root);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Autonomy job not found: ${jobId}`);
  if (job.status !== "active") throw new Error(`Autonomy job is not active: ${jobId}`);

  markAutonomyJobRunning(jobId);
  emitStateChange(["autonomy"]);
  try {
    const handler = AUTONOMY_JOB_HANDLERS[jobId];
    let result: AutonomyRunResult;
    try {
      result = handler
        ? await handler(root)
        : { jobId, status: "blocked" as const, summary: "Unknown autonomy job", proposalsCreated: 0 };
    } catch (error) {
      // A handler throw (e.g. a transient `fetch failed` / ETIMEDOUT from a
      // connector) must not abort the daemon tick or skip run recording.
      // Convert it to a blocked run so the rest of the tick continues and the
      // failure stays visible in run history rather than escaping to onError.
      const message = error instanceof Error ? error.message : String(error);
      result = { jobId, status: "blocked", summary: `Autonomy job ${jobId} failed: ${message}`, proposalsCreated: 0 };
    }
    await updateJobRun(root, jobId, result);
    return result;
  } finally {
    clearAutonomyJobRunning(jobId);
    emitStateChange(["autonomy"]);
  }
}

export async function pickDueAutomaticJob(root: string): Promise<AutonomyJob | null> {
  const jobs = await listAutonomyJobs(root);
  const due = jobs.filter((job) => {
    if (job.status !== "active" || job.runMode !== "automatic") return false;
    if (!job.nextRunAt) return parseSchedule(job.schedule) !== null;
    return Date.parse(job.nextRunAt) <= Date.now();
  });
  return due[0] ?? null;
}

async function updateJobRun(root: string, jobId: string, result: AutonomyRunResult): Promise<void> {
  const jobs = await listAutonomyJobs(root);
  const updated = jobs.map((job) =>
    job.id === jobId
      ? { ...job, lastRunAt: now(), lastSummary: result.summary, nextRunAt: nextRunFor(job.schedule, now()) }
      : job
  );
  await writeJsonFile(jobsPath(root), updated);

  const history = await readJsonFile<AutonomyRunResult[]>(autonomyRunsPath(root), []);
  history.unshift({ ...result, jobId });
  await writeJsonFile(autonomyRunsPath(root), history.slice(0, 200));
}
