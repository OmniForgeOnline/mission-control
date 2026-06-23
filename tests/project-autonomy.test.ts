import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";
import { listProjectJobs, runProjectJob, setProjectJobRunMode } from "../src/core/projects/scoped-autonomy.ts";
import { writeJsonFile } from "../src/core/infra/fs.ts";
import { listTasks } from "../src/core/tasks/tasks.ts";
import { runAutonomyAgentTurn } from "../src/autonomy/agent-run.ts";
import type { AgentRunner, AgentTurnRequest } from "../src/runners/types.ts";

describe("project autonomy", () => {
  let tmp: string;
  let projectId: string;
  let projectRepoPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "harness-proj-auto-"));
    const { execSync } = await import("node:child_process");
    execSync(`git init my-repo`, { cwd: tmp });
    execSync("git config user.email t@t.com", { cwd: path.join(tmp, "my-repo") });
    execSync("git config user.name t", { cwd: path.join(tmp, "my-repo") });
    const project = await onboardProject(tmp, {
      repoPath: path.join(tmp, "my-repo"),
      name: "Test Project"
    });
    projectId = project.id;
    projectRepoPath = project.repoPath;
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("seeds 8 project jobs with manual runMode", async () => {
    const jobs = await listProjectJobs(tmp, projectId);
    expect(jobs).toHaveLength(8);
    expect(jobs.every((j) => j.runMode === "manual")).toBe(true);
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain("quality-grade-update");
    expect(ids).toContain("quality-gate-sweep");
    expect(ids).toContain("tech-debt-sweep");
    expect(ids).toContain("turn-evolution-review");
    expect(ids).toContain("project-self-improvement");
    expect(ids).toContain("project-operational-triage");
    expect(ids).toContain("memory-index-refresh");
    expect(ids).toContain("doc-gardening");
  });

  it("persists runMode change", async () => {
    await setProjectJobRunMode(tmp, projectId, "quality-gate-sweep", "automatic");
    const jobs = await listProjectJobs(tmp, projectId);
    const job = jobs.find((j) => j.id === "quality-gate-sweep")!;
    expect(job.runMode).toBe("automatic");
  });

  it("throws for unknown project", async () => {
    await expect(listProjectJobs(tmp, "proj-noexist")).rejects.toThrow(/project not found/i);
  });

  it("throws for unknown job name", async () => {
    await expect(setProjectJobRunMode(tmp, projectId, "no-such-job", "automatic")).rejects.toThrow(/not found/);
  });

  it("anchors project tech-debt tasks to the project", async () => {
    await writeJsonFile(path.join(projectDir(tmp, projectId), "tech-debt.json"), [
      {
        id: "td-1",
        title: "Fix project issue",
        description: "Repair the project issue.",
        status: "open"
      }
    ]);

    await runProjectJob(tmp, projectId, "tech-debt-sweep");

    const [task] = await listTasks(tmp);
    expect(task).toMatchObject({
      title: "Tech debt (Test Project): Fix project issue",
      projectId,
      repoPath: projectRepoPath
    });
  });

  it("anchors project quality-gate tasks to the project", async () => {
    await mkdir(path.join(projectDir(tmp, projectId)), { recursive: true });
    await writeJsonFile(path.join(projectDir(tmp, projectId), "quality.json"), {
      updatedAt: new Date().toISOString(),
      domains: {
        core: {
          grade: "C",
          evidence: [path.join(tmp, "my-repo", "src", "core")],
          summary: "No tests reference this domain."
        }
      }
    });

    await runProjectJob(tmp, projectId, "quality-gate-sweep");

    const [task] = await listTasks(tmp);
    expect(task).toMatchObject({
      projectId,
      repoPath: projectRepoPath
    });
  });

  it("passes project context to project autonomy agent turns", async () => {
    let observed: AgentTurnRequest | undefined;
    const runner: AgentRunner = {
      agent: "claude",
      abort: () => {},
      runTurn: async (request) => {
        observed = request;
        return {
          reply: "Reviewed project context.",
          exitCode: 0,
          command: "fake claude",
          rawLog: ""
        };
      }
    };

    await runAutonomyAgentTurn(
      tmp,
      {
        taskId: `autonomy:project:${projectId}:test`,
        taskTitle: "Project context test",
        stateFileName: `${projectId}/agent-context-test.json`,
        projectId,
        repoPath: projectRepoPath,
        skipSummary: "Already running.",
        completedSummary: () => "Done.",
        blockedSummary: (reason) => `Blocked: ${reason}`,
        buildContext: async () => "context",
        buildPrompt: () => "prompt"
      },
      { runner }
    );

    expect(observed?.task).toMatchObject({
      projectId,
      repoPath: projectRepoPath
    });
  });
});
