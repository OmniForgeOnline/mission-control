import type { AutonomyJob } from "./job-types.ts";

export function now(): string {
  return new Date().toISOString();
}

export function parseSchedule(schedule: string): number | null {
  const match = schedule.match(/^every-(\d+)([mhd])$/);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2];
  const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * ms;
}

export function nextRunFor(schedule: string, lastRunAt?: string): string | undefined {
  const intervalMs = parseSchedule(schedule);
  if (!intervalMs) return undefined;
  const base = lastRunAt ? Date.parse(lastRunAt) : Date.now() - intervalMs;
  return new Date(base + intervalMs).toISOString();
}

export function withDefaults(job: AutonomyJob): AutonomyJob {
  const nextRunAt = job.nextRunAt ?? nextRunFor(job.schedule, job.lastRunAt);
  return {
    ...job,
    runMode: job.runMode ?? "manual",
    ...(nextRunAt !== undefined ? { nextRunAt } : {})
  };
}