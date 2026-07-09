import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import {
  listAutonomyJobs,
  runAutonomyJob,
  setAutonomyJobRunMode,
  setAutonomyJobStatus
} from "../src/autonomy/jobs.ts";
import {
  attachAutonomyJobRuntime,
  clearAutonomyJobRunning,
  markAutonomyJobRunning
} from "../src/autonomy/runtime.ts";
import { AUTONOMY_JOB_HANDLERS } from "../src/autonomy/registry.ts";
import { runOperationalErrorTriage } from "../src/autonomy/error-triage.ts";
import { buildGuidanceSweepContext, buildGuidanceSweepPrompt } from "../src/autonomy/guidance-sweep.ts";
import { runAutonomyAgentTurn } from "../src/autonomy/agent-run.ts";
import { captureOperationalError, listOperationalErrors } from "../src/core/operations/error-ledger.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { writeJsonFile } from "../src/core/infra/fs.ts";
import { createRun } from "../src/core/tasks/runs.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createServer } from "../src/server/app.ts";

describe("autonomy jobs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-autonomy-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("seeds bounded default jobs that require proposal-based durable changes", async () => {
    const jobs = await listAutonomyJobs(root);

    const ids = jobs.map((job) => job.id).sort();
    expect(ids).toEqual([
      "clickup-ticket-sync",
      "merge-status-sweep",
      "workflow-reconcile-sweep",
      "worktree-cleanup-sweep"
    ]);
    expect(jobs.find((j) => j.id === "worktree-cleanup-sweep")).toMatchObject({
      approvalPolicy: "read-only",
      runMode: "automatic",
      status: "active"
    });
    expect(jobs.find((j) => j.id === "merge-status-sweep")).toMatchObject({
      approvalPolicy: "read-only",
      runMode: "automatic",
      schedule: "every-1h",
      status: "active"
    });
    expect(jobs.find((j) => j.id === "workflow-reconcile-sweep")).toMatchObject({
      approvalPolicy: "read-only",
      runMode: "automatic",
      schedule: "every-1h",
      status: "active"
    });
    expect(jobs.find((j) => j.id === "clickup-ticket-sync")).toMatchObject({
      approvalPolicy: "synthetic-task",
      runMode: "automatic",
      schedule: "every-5m",
      status: "paused"
    });
    await expect(readFile(path.join(root, "data", "state", "autonomy-jobs.json"), "utf8")).resolves.toContain(
      "merge-status-sweep"
    );
  });

  it("builds the guidance sweep context from the repo's kernel and README", async () => {
    const memoryPolicyPath = path.join(root, "kernel", "memory-policy.md");
    await writeFile(
      memoryPolicyPath,
      "# Memory\n\nDo not rely on a standalone gbrain CLI, MCP server, daemon, or external app.\n",
      "utf8"
    );

    const context = await buildGuidanceSweepContext(root);

    expect(context).toContain("kernel/memory-policy.md");
    expect(context).toContain("Do not rely on a standalone gbrain CLI");
    expect(context).toContain("Known stale phrases to watch for");
    expect(buildGuidanceSweepPrompt("sample")).toContain("guidance-sweep agent");
  });

  it("skips an agent-turn autonomy job that is already running", async () => {
    const taskId = "autonomy:test-agent-turn";
    await createRun(root, {
      taskId,
      taskTitle: "Test agent turn",
      agent: "grok",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: []
    });

    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies(["should not run"]);

    const result = await runAutonomyAgentTurn(
      root,
      {
        taskId,
        taskTitle: "Test agent turn",
        stateFileName: "test-agent-turn.json",
        skipSummary: "Test agent turn skipped: already running.",
        completedSummary: () => "completed",
        blockedSummary: (reason) => `blocked: ${reason}`,
        buildContext: async () => "ctx",
        buildPrompt: () => "prompt"
      },
      { runner }
    );

    expect(result).toMatchObject({
      status: "completed",
      summary: "Test agent turn skipped: already running.",
      proposalsCreated: 0
    });
  });

  it("records a throwing handler as a blocked run instead of aborting the tick", async () => {
    // A transient handler failure (e.g. ClickUp `fetch failed` / ETIMEDOUT) used
    // to escape runAutonomyJob, skip run recording, and surface as a daemon
    // onError. It must now resolve as a blocked run so the tick continues.
    const jobId = "worktree-cleanup-sweep";
    const original = AUTONOMY_JOB_HANDLERS[jobId]!;
    AUTONOMY_JOB_HANDLERS[jobId] = async () => {
      throw new Error("fetch failed: ETIMEDOUT");
    };
    try {
      const result = await runAutonomyJob(root, jobId);

      expect(result).toMatchObject({ jobId, status: "blocked" });
      expect(result.summary).toContain("ETIMEDOUT");
      // The run was recorded as blocked, not dropped on the floor.
      const runs = JSON.parse(await readFile(path.join(root, "data", "state", "autonomy-runs.json"), "utf8"));
      expect(runs[0]).toMatchObject({ jobId, status: "blocked" });
    } finally {
      AUTONOMY_JOB_HANDLERS[jobId] = original;
    }
  });

  it("triages captured operational errors and marks them reviewed", async () => {
    await captureOperationalError(root, {
      message: "Merge request creation failed: connector returned 500",
      taskId: "33333333-3333-3333-3333-333333333333",
      taskTitle: "Quality gate: runtime",
      workflowStep: "create_merge_request"
    });

    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies(["Reviewed the commit failure. Filed tech debt to auto-remediate pre-commit lint issues."]);
    const result = await runOperationalErrorTriage(root, { runner });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Error triage turn 1 completed");
    const errors = await listOperationalErrors(root);
    expect(errors[0]?.status).toBe("triaged");
  });

  it("toggles jobs between manual and automatic run modes", async () => {
    const updated = await setAutonomyJobRunMode(root, "worktree-cleanup-sweep", "manual");

    expect(updated.runMode).toBe("manual");
    expect((await listAutonomyJobs(root)).find((job) => job.id === "worktree-cleanup-sweep")?.runMode).toBe("manual");
  });

  it("refreshes stale autonomy job descriptions from code defaults", async () => {
    await writeJsonFile(path.join(root, "data", "state", "autonomy-jobs.json"), [
      {
        id: "worktree-cleanup-sweep",
        title: "Worktree cleanup sweep",
        description: "Old description that drifted from the code default.",
        schedule: "every-1h",
        status: "active",
        runMode: "automatic",
        approvalPolicy: "read-only"
      }
    ]);

    const jobs = await listAutonomyJobs(root);

    expect(jobs.find((j) => j.id === "worktree-cleanup-sweep")?.description).toBe(
      "Remove isolated git worktrees after their merge requests have been merged."
    );
  });

  it("migrates stored ClickUp sync job config while preserving operator-set status", async () => {
    await writeJsonFile(path.join(root, "data", "state", "autonomy-jobs.json"), [
      {
        id: "clickup-ticket-sync",
        title: "ClickUp ticket sync",
        description: "Poll subscribed ClickUp lists for @omc tickets and mirror harness lifecycle updates upstream.",
        schedule: "every-99h",
        status: "active",
        runMode: "manual",
        approvalPolicy: "synthetic-task"
      }
    ]);

    const job = (await listAutonomyJobs(root)).find((entry) => entry.id === "clickup-ticket-sync");

    expect(job).toMatchObject({
      approvalPolicy: "synthetic-task",
      runMode: "automatic",
      schedule: "every-5m",
      status: "active"
    });
  });

  it("activates a paused job and the activation survives reload", async () => {
    const activated = await setAutonomyJobStatus(root, "clickup-ticket-sync", "active");

    expect(activated.status).toBe("active");
    const reloaded = (await listAutonomyJobs(root)).find((job) => job.id === "clickup-ticket-sync");
    expect(reloaded?.status).toBe("active");
  });

  it("attachAutonomyJobRuntime marks inflight jobs and active autonomy runs", async () => {
    const jobs = await listAutonomyJobs(root);

    markAutonomyJobRunning("worktree-cleanup-sweep");
    const inflight = await attachAutonomyJobRuntime(root, jobs);
    expect(inflight.find((job) => job.id === "worktree-cleanup-sweep")).toMatchObject({ isRunning: true });
    clearAutonomyJobRunning("worktree-cleanup-sweep");

    const run = await createRun(root, {
      taskId: "autonomy:merge-status-sweep",
      taskTitle: "Merge status sweep",
      agent: "grok",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: []
    });
    const withRun = await attachAutonomyJobRuntime(root, jobs);
    expect(withRun.find((job) => job.id === "merge-status-sweep")).toMatchObject({
      isRunning: true,
      activeRunId: run.id
    });
  });

  it("exposes running autonomy jobs through mission-control state", async () => {
    const app = createServer({ root });
    markAutonomyJobRunning("worktree-cleanup-sweep");
    try {
      const state = await request(app).get("/api/state").expect(200);
      expect(state.body.autonomyJobs.find((job: { id: string }) => job.id === "worktree-cleanup-sweep")).toMatchObject({
        isRunning: true
      });
    } finally {
      clearAutonomyJobRunning("worktree-cleanup-sweep");
    }
  });

  it("exposes autonomy jobs and manual runs through the mission-control API", async () => {
    const app = createServer({ root });

    const state = await request(app).get("/api/state").expect(200);
    expect(state.body.autonomyJobs.map((job: { id: string }) => job.id)).toContain("worktree-cleanup-sweep");

    const run = await request(app).post("/api/autonomy/jobs/worktree-cleanup-sweep/run").expect(200);
    expect(run.body.status).toBe("completed");
    expect(run.body.summary.toLowerCase()).toContain("worktree");

    const updated = await request(app)
      .post("/api/autonomy/jobs/worktree-cleanup-sweep/run-mode")
      .send({ runMode: "manual" })
      .expect(200);
    expect(updated.body.runMode).toBe("manual");

    const activated = await request(app)
      .post("/api/autonomy/jobs/clickup-ticket-sync/status")
      .send({ status: "active" })
      .expect(200);
    expect(activated.body.status).toBe("active");
  });
});
