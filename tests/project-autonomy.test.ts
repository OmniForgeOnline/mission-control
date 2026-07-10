import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";
import { defineProjectJob, listProjectJobs, runProjectJob, setProjectJobRunMode } from "../src/core/projects/scoped-autonomy.ts";
import { readJsonFile, writeJsonFile } from "../src/core/infra/fs.ts";
import { autonomyRunsPath, type AutonomyRunResult } from "../src/autonomy/job-types.ts";
import { listTasks } from "../src/core/tasks/tasks.ts";
import { runAutonomyAgentTurn } from "../src/autonomy/agent-run.ts";
import {
  buildProjectSelfImprovementContext,
  buildProjectSelfImprovementPrompt
} from "../src/autonomy/handlers/project-self-improvement.ts";
import { writeQualityGate, writeProjectQualityGateRun } from "../src/core/projects/quality-gate.ts";
import type { AgentRunner, AgentTurnRequest } from "../src/runners/types.ts";

type ProjectRef = { id: string; name: string; repoPath: string };

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

  it("seeds 7 project jobs with manual runMode", async () => {
    const jobs = await listProjectJobs(tmp, projectId);
    expect(jobs).toHaveLength(7);
    expect(jobs.every((j) => j.runMode === "manual")).toBe(true);
    const ids = jobs.map((j) => j.id);
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

  it("anchors project quality-gate remediation tasks to the project", async () => {
    // A failing check in the last gate run → the sweep files a remediation task
    // anchored to this project (projectId + repoPath), not the harness root.
    await writeProjectQualityGateRun(tmp, projectId, {
      runAt: new Date().toISOString(),
      outcome: "failed",
      pass: false,
      results: [{ name: "lint", command: "ruff check .", status: "failed", exitCode: 1, output: "boom" }]
    });

    await runProjectJob(tmp, projectId, "quality-gate-sweep");

    const [task] = await listTasks(tmp);
    expect(task).toMatchObject({
      projectId,
      repoPath: projectRepoPath
    });
    expect(task?.title).toBe("Quality gate: lint");
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

  it("feeds the quality-gate state and last run results into self-improvement context", async () => {
    const project: ProjectRef = { id: projectId, name: "Test Project", repoPath: projectRepoPath };
    await writeQualityGate(tmp, projectId, {
      status: "incomplete",
      checks: [],
      needsResolution: ["no lint command documented"]
    });
    await writeProjectQualityGateRun(tmp, projectId, {
      runAt: "2026-01-01T00:00:00.000Z",
      outcome: "failed",
      pass: false,
      results: [{ name: "tests", command: "pytest", status: "failed", exitCode: 1, output: "boom" }]
    });

    const context = await buildProjectSelfImprovementContext(tmp, project);

    expect(context).toContain("Quality gate");
    expect(context).toContain("incomplete");
    expect(context).toContain("no lint command documented");
    // The last run's failing check is surfaced so the agent can act on real pass/fail.
    expect(context).toContain("tests");
    expect(context).toContain("failed");
  });

  it("instructs the self-improvement agent to resolve gate gaps and failing checks", async () => {
    const project: ProjectRef = { id: projectId, name: "Test Project", repoPath: projectRepoPath };
    const prompt = buildProjectSelfImprovementPrompt(project, "ctx");

    expect(prompt).toContain("quality gate");
    expect(prompt).toContain("failing");
  });

  it("records a blocked run in history when a custom-job agent turn throws (mirrors runAutonomyJob)", async () => {
    // Custom jobs route through runCustomProjectJob -> runAutonomyAgentTurn. A throw
    // there must become a recorded blocked run rather than escape runProjectJob to
    // the daemon tick's onError (the defect runAutonomyJob was hardened against).
    const def = await defineProjectJob(tmp, projectId, {
      id: "boom-job",
      title: "Boom job",
      description: "Agent turn always throws.",
      schedule: "every-1d",
      runMode: "manual",
      approvalPolicy: "read-only",
      instructions: "Investigate; the runner will throw."
    });
    expect(def.ok).toBe(true);

    const throwingRunner: AgentRunner = {
      agent: "claude",
      abort: () => {},
      runTurn: async () => {
        throw new Error("agent exploded");
      }
    };

    const result = await runProjectJob(tmp, projectId, "boom-job", { runner: throwingRunner });
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/agent exploded/);

    // The run must still be recorded in the harness-wide history (previously skipped).
    const history = await readJsonFile<AutonomyRunResult[]>(autonomyRunsPath(tmp), []);
    expect(history[0]).toMatchObject({ status: "blocked" });
    expect(history[0]?.summary).toMatch(/agent exploded/);
  });
});
