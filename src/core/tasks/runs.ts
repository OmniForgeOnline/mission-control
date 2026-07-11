import crypto from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { readJsonFile, updateJsonFile, writeJsonFile } from "../infra/fs.ts";
import { emitStateChange, type StateScope } from "../infra/state-bus.ts";
import { ensureHarnessRepository } from "../bootstrap/repository.ts";
import { listProjects, projectDir } from "../projects/registry.ts";
import { EntityNotFoundError } from "./errors.ts";
import type { HarnessRun } from "../types.ts";

/**
 * Run storage is scoped per project (option #1): each project's run index lives
 * at `data/state/projects/<id>/runs.json`, while project-less daemon-maintenance
 * runs (autonomy jobs with no project) live in the harness-level
 * `data/state/runs.json`. Run artifacts and the live event stream stay flat
 * under `data/runs/<runId>/` because `runId` is globally unique.
 */
function runsPathFor(root: string, projectId?: string): string {
  return projectId
    ? path.join(projectDir(root, projectId), "runs.json")
    : path.join(root, "data", "state", "runs.json");
}

function runDir(root: string, runId: string): string {
  return path.join(root, "data", "runs", runId);
}

function runStateScopes(taskId: string): StateScope[] {
  const scopes: StateScope[] = ["chrome", "runs", `task:${taskId}`];
  if (taskId.startsWith("autonomy:")) scopes.push("autonomy");
  return scopes;
}

/** Runs for a single bucket: a project's runs, or the maintenance bucket when `projectId` is omitted. */
export async function listRuns(root: string, projectId?: string): Promise<HarnessRun[]> {
  await ensureHarnessRepository(root);
  return readJsonFile<HarnessRun[]>(runsPathFor(root, projectId), []);
}

/** Every run across the maintenance bucket and all onboarded projects. */
export async function listAllRuns(root: string): Promise<HarnessRun[]> {
  const projects = await listProjects(root);
  const buckets = await Promise.all([
    readJsonFile<HarnessRun[]>(runsPathFor(root), []),
    ...projects.map((project) => readJsonFile<HarnessRun[]>(runsPathFor(root, project.id), []))
  ]);
  return buckets.flat();
}

export async function createRun(root: string, input: Omit<HarnessRun, "id">): Promise<HarnessRun> {
  await ensureHarnessRepository(root);
  const run: HarnessRun = { id: crypto.randomUUID(), ...input };
  const file = runsPathFor(root, run.projectId);
  const runs = await readJsonFile<HarnessRun[]>(file, []);
  await writeJsonFile(file, [run, ...runs]);
  emitStateChange(runStateScopes(run.taskId));
  return run;
}

export async function claimRunForTask(root: string, input: Omit<HarnessRun, "id">): Promise<HarnessRun | null> {
  await ensureHarnessRepository(root);
  const run: HarnessRun = { id: crypto.randomUUID(), ...input };
  const persisted = await updateJsonFile<HarnessRun[]>(runsPathFor(root, run.projectId), [], (runs) => {
    if (runs.some((existing) => existing.taskId === input.taskId && existing.status === "running")) {
      return runs;
    }
    return [run, ...runs];
  });
  const claimed = persisted.find((existing) => existing.id === run.id) ?? null;
  if (claimed) {
    emitStateChange(runStateScopes(claimed.taskId));
  }
  return claimed;
}

export async function updateRun(root: string, runId: string, updates: Partial<HarnessRun>): Promise<HarnessRun> {
  const located = (await listAllRuns(root)).find((run) => run.id === runId);
  if (!located) {
    throw new EntityNotFoundError("run", runId);
  }
  const defined = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined)
  ) as Partial<HarnessRun>;
  let updated: HarnessRun = located;
  await updateJsonFile<HarnessRun[]>(runsPathFor(root, located.projectId), [], (runs) => {
    const index = runs.findIndex((run) => run.id === runId);
    if (index === -1) return runs;
    updated = { ...runs[index]!, ...defined };
    const next = [...runs];
    next[index] = updated;
    return next;
  });
  emitStateChange(runStateScopes(updated.taskId));
  return updated;
}

/** Remove finished (non-running) runs from one bucket and delete their flat artifact dirs. */
export async function cleanRuns(root: string, projectId?: string): Promise<{ deleted: number }> {
  const runs = await listRuns(root, projectId);
  const kept = runs.filter((run) => run.status === "running");
  const deleted = runs.filter((run) => run.status !== "running");
  await writeJsonFile(runsPathFor(root, projectId), kept);
  emitStateChange(["chrome", "runs"]);
  await Promise.all(
    deleted.map((run) => rm(runDir(root, run.id), { recursive: true, force: true }))
  );
  return { deleted: deleted.length };
}
