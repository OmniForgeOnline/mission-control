import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { createServer } from "../src/server/app.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";
import type { ToolId } from "../src/core/types.ts";
import { createProposal } from "../src/core/proposals/proposals.ts";
import { createRun } from "../src/core/tasks/runs.ts";
import { approveTask, setTaskStatus } from "../src/core/tasks/tasks.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import type { HarnessTask } from "../src/core/types.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";

class HoldingRunner implements AgentRunner {
  agent: ToolId = "codex";
  aborted = false;
  private resolveTurn: ((value: AgentTurnResult) => void) | null = null;

  abort(): void {
    this.aborted = true;
    if (this.resolveTurn) {
      const resolve = this.resolveTurn;
      this.resolveTurn = null;
      resolve({
        reply: "",
        exitCode: 1,
        command: "holding",
        blockedReason: "Stopped by operator",
        rawLog: "Aborted by operator."
      });
    }
  }

  runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    request.onOutput?.("Holding runner started.\n");
    return new Promise<AgentTurnResult>((resolve) => {
      this.resolveTurn = resolve;
    });
  }
}

describe("mission-control API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-api-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("supports the task approval, run, artifact, and proposal review flow", async () => {
    const app = createServer({ root, runner: new DeterministicAgentRunner("codex"), testMode: true });

    const created = await request(app)
      .post("/api/tasks")
      .send({
        title: "Draft docs",
        description: "Create a useful getting-started guide.",
        agent: "codex",
        source: "manual",
        links: []
      })
      .expect(201);

    await request(app).post(`/api/tasks/${created.body.id}/approve`).expect(200);
    const run = await request(app).post("/api/daemon/process-one").expect(200);
    expect(run.body.runId).toBeDefined();

    const state = await request(app).get("/api/state").expect(200);
    expect(state.body.tasks[0].turnCount).toBe(1);
    expect(state.body.runs[0].artifacts).toContain("summary.md");

    const proposal = await createProposal(root, {
      kind: "skill",
      title: "Review release notes",
      rationale: "Repeatable release workflow.",
      targetPath: "skills/release-notes/SKILL.md",
      content: "# Release Notes\n\nCheck the changelog before drafting.\n"
    });

    await request(app).post(`/api/tasks/${proposal.id}/approve`).expect(200);
    const turn = await request(app).post(`/api/tasks/${proposal.id}/turn`).expect(200);
    expect(turn.body.runId).toBeDefined();

    const afterRun = await request(app).get("/api/state").expect(200);
    const proposalTask = afterRun.body.tasks.find((task: { id: string }) => task.id === proposal.id);
    expect(proposalTask?.workflowRun?.workflowId).toBeDefined();
    expect(proposalTask?.turnCount).toBe(1);
  });

  it("deletes queued tasks and cleans completed runs from mission control", async () => {
    const app = createServer({ root, runner: new DeterministicAgentRunner("codex"), testMode: true });

    const queued = await request(app)
      .post("/api/tasks")
      .send({
        title: "Remove me",
        description: "This task should be deleted.",
        agent: "codex",
        source: "manual",
        links: []
      })
      .expect(201);

    await request(app).delete(`/api/tasks/${queued.body.id}`).expect(200);
    expect((await request(app).get("/api/state").expect(200)).body.tasks).toHaveLength(0);

    const runnable = await request(app)
      .post("/api/tasks")
      .send({
        title: "Run me",
        description: "This task should create a run.",
        agent: "codex",
        source: "manual",
        links: []
      })
      .expect(201);
    await request(app).post(`/api/tasks/${runnable.body.id}/approve`).expect(200);
    await request(app).post("/api/daemon/process-one").expect(200);

    await request(app).post("/api/runs/clean").expect(200);
    expect((await request(app).get("/api/state").expect(200)).body.runs).toHaveLength(0);
  });

  it("bulk deletes selected tasks and selected runs", async () => {
    const app = createServer({ root, runner: new DeterministicAgentRunner("codex"), testMode: true });
    const first = await request(app)
      .post("/api/tasks")
      .send({ title: "First", description: "Delete in bulk.", agent: "codex", source: "manual", links: [] })
      .expect(201);
    const second = await request(app)
      .post("/api/tasks")
      .send({ title: "Second", description: "Keep this one.", agent: "codex", source: "manual", links: [] })
      .expect(201);

    await request(app).post("/api/tasks/delete").send({ ids: [first.body.id] }).expect(200);
    expect((await request(app).get("/api/state").expect(200)).body.tasks.map((task: { id: string }) => task.id)).toEqual([
      second.body.id
    ]);

    await request(app).post(`/api/tasks/${second.body.id}/approve`).expect(200);
    await request(app).post("/api/daemon/process-one").expect(200);
    await request(app).post("/api/runs/clean").expect(200);
    expect((await request(app).get("/api/state").expect(200)).body.runs).toHaveLength(0);
  });

  it("stops a running task immediately when the run kill endpoint is called", async () => {
    const runner = new HoldingRunner();
    const app = createServer({ root, runner });
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "Hold", description: "Stay running until stopped.", agent: "codex", source: "manual", links: [] })
      .expect(201);

    await request(app).post(`/api/tasks/${task.body.id}/approve`).expect(200);
    const run = await request(app).post(`/api/tasks/${task.body.id}/turn`).expect(200);
    expect(run.body.execution).toBe("running");

    await request(app).post(`/api/runs/${run.body.runId}/kill`).expect(200);

    expect(runner.aborted).toBe(true);

    let taskStatus = "";
    let runStatus = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const state = await request(app).get("/api/state").expect(200);
      const pausedTask = state.body.tasks.find((candidate: { id: string }) => candidate.id === task.body.id) as HarnessTask;
      taskStatus = await taskLegacyStatus(root, pausedTask);
      runStatus = state.body.runs.find((candidate: { id: string }) => candidate.id === run.body.runId).status;
      if (taskStatus === "paused" && runStatus === "paused") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(taskStatus).toBe("paused");
    expect(runStatus).toBe("paused");
  });

  it("stops stale running state even when no live process is registered", async () => {
    const app = createServer({ root });
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "Stale", description: "Was running before a server restart.", agent: "codex", source: "manual", links: [] })
      .expect(201);
    await approveTask(root, task.body.id);
    await setTaskStatus(root, task.body.id, "running");
    const run = await createRun(root, {
      taskId: task.body.id,
      taskTitle: task.body.title,
      agent: "codex",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: ["prompt.md", "log.txt"]
    });

    await request(app).post(`/api/runs/${run.id}/kill`).expect(200);

    const state = await request(app).get("/api/state").expect(200);
    const staleTask = state.body.tasks.find((candidate: { id: string }) => candidate.id === task.body.id) as HarnessTask;
    expect(await taskLegacyStatus(root, staleTask)).toBe("paused");
    expect(state.body.runs.find((candidate: { id: string }) => candidate.id === run.id).status).toBe("paused");
  });

  it("returns an empty tail chunk when the run log has not been created yet", async () => {
    const app = createServer({ root, testMode: true });
    // Drop supertest's .expect(200) and assert manually so a non-200 response
    // surfaces its body in the failure message, revealing the 404's source
    // (route fallback vs. handler catch) instead of just the status code.
    const res = await request(app).get("/api/runs/missing-run-id/tail?since=0");
    expect(res.status, `unexpected tail response body: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body).toEqual({ size: 0, chunk: "", endOfFile: false });
  });
});
