import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";
import {
  cleanRuns,
  claimRunForTask,
  createRun,
  listAllRuns,
  listRuns,
  updateRun
} from "../src/core/tasks/runs.ts";

async function onboard(root: string, name: string): Promise<string> {
  const repo = path.join(root, name);
  execSync(`git init ${name}`, { cwd: root });
  const project = await onboardProject(root, { repoPath: repo, name });
  return project.id;
}

function baseRun(projectId: string | undefined, taskId: string) {
  return {
    taskId,
    taskTitle: `Task ${taskId}`,
    agent: "codex" as const,
    status: "running" as const,
    startedAt: new Date().toISOString(),
    artifacts: ["prompt.md", "log.txt"],
    ...(projectId !== undefined ? { projectId } : {})
  };
}

describe("per-project run storage", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-runs-"));
    execSync("git init", { cwd: root });
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("writes a project run under that project's state dir", async () => {
    const projectId = await onboard(root, "alpha");
    const run = await createRun(root, baseRun(projectId, "t1"));

    expect(run.projectId).toBe(projectId);
    const stored = await readFile(path.join(projectDir(root, projectId), "runs.json"), "utf8");
    expect(JSON.parse(stored)[0].id).toBe(run.id);
    // Not in the maintenance bucket.
    expect(await listRuns(root)).toEqual([]);
  });

  it("isolates runs between projects", async () => {
    const a = await onboard(root, "alpha");
    const b = await onboard(root, "beta");
    const runA = await createRun(root, baseRun(a, "ta"));
    const runB = await createRun(root, baseRun(b, "tb"));

    expect((await listRuns(root, a)).map((r) => r.id)).toEqual([runA.id]);
    expect((await listRuns(root, b)).map((r) => r.id)).toEqual([runB.id]);
  });

  it("stores project-less maintenance runs in the harness-level bucket", async () => {
    const run = await createRun(root, baseRun(undefined, "autonomy:worktree-cleanup-sweep"));

    const stored = await readFile(path.join(root, "data", "state", "runs.json"), "utf8");
    expect(JSON.parse(stored)[0].id).toBe(run.id);
    expect((await listRuns(root)).map((r) => r.id)).toEqual([run.id]);
  });

  it("aggregates maintenance + every project via listAllRuns", async () => {
    const a = await onboard(root, "alpha");
    const b = await onboard(root, "beta");
    const runA = await createRun(root, baseRun(a, "ta"));
    const runB = await createRun(root, baseRun(b, "tb"));
    const maintenance = await createRun(root, baseRun(undefined, "autonomy:clickup-ticket-sync"));

    const all = (await listAllRuns(root)).map((r) => r.id).sort();
    expect(all).toEqual([runA.id, runB.id, maintenance.id].sort());
  });

  it("locates and updates a run regardless of bucket", async () => {
    const a = await onboard(root, "alpha");
    const projectRun = await createRun(root, baseRun(a, "ta"));
    const maintenanceRun = await createRun(root, baseRun(undefined, "autonomy:worktree-cleanup-sweep"));

    await updateRun(root, projectRun.id, { status: "completed" });
    await updateRun(root, maintenanceRun.id, { status: "blocked", blockedReason: "x" });

    expect((await listRuns(root, a))[0]!.status).toBe("completed");
    expect((await listRuns(root))[0]!.status).toBe("blocked");
  });

  it("claimRunForTask dedups per project and routes to the project bucket", async () => {
    const a = await onboard(root, "alpha");
    const first = await claimRunForTask(root, baseRun(a, "ta"));
    const second = await claimRunForTask(root, baseRun(a, "ta"));

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect((await listRuns(root, a)).length).toBe(1);
  });

  it("cleanRuns only clears the targeted project's finished runs + artifacts", async () => {
    const a = await onboard(root, "alpha");
    const b = await onboard(root, "beta");
    const finished = await createRun(root, baseRun(a, "ta"));
    await updateRun(root, finished.id, { status: "completed" });
    const running = await createRun(root, { ...baseRun(a, "ta2"), taskId: "ta2" });
    const otherProject = await createRun(root, baseRun(b, "tb"));

    // Flat artifact dir for the finished run.
    const artifactDir = path.join(root, "data", "runs", finished.id);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "log.txt"), "x", "utf8");

    const result = await cleanRuns(root, a);
    expect(result.deleted).toBe(1);
    expect(existsSync(artifactDir)).toBe(false);
    expect((await listRuns(root, a)).map((r) => r.id)).toEqual([running.id]);
    // Project B untouched.
    expect((await listRuns(root, b)).map((r) => r.id)).toEqual([otherProject.id]);
  });
});
