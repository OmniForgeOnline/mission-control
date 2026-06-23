import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { processNextApprovedTask, runOperatorFollowupTurn } from "../src/daemon/processor.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { createServer } from "../src/server/app.ts";
import { approveTask, createTask, getTask } from "../src/core/tasks/tasks.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";

describe("operator interaction", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-interaction-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores operator notes on tasks and includes them in the agent prompt", async () => {
    const task = await createTask(root, {
      title: "Use operator notes",
      description: "Do the work.",
      agent: "codex",
      source: "manual",
      links: []
    });
    const app = createServer({ root, runner: new DeterministicAgentRunner("codex"), testMode: true });

    await request(app)
      .post(`/api/tasks/${task.id}/messages`)
      .send({ author: "operator", body: "Focus on the failing test first." })
      .expect(201);
    await approveTask(root, task.id);
    const result = await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });

    const updated = await getTask(root, task.id);
    expect(updated?.messages.find((m) => m.author === "operator")?.body).toBe("Focus on the failing test first.");
    await expect(readFile(path.join(root, "data", "runs", result!.runId, "prompt.md"), "utf8")).resolves.toContain(
      "Focus on the failing test first."
    );
  });

  it("writes runner output to the run log artifact", async () => {
    const task = await createTask(root, {
      title: "Capture output",
      description: "Run fake agent.",
      agent: "claude",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    const result = await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("claude"), wait: true });

    await expect(readFile(path.join(root, "data", "runs", result!.runId, "log.txt"), "utf8")).resolves.toContain(
      "Deterministic claude reply"
    );
  });

  it("stores workflow agent replies on the current step", async () => {
    const task = await createTask(root, {
      title: "Scoped agent reply",
      description: "Plan the work.",
      workflowId: "code-feature",
      agent: "codex",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });

    const updated = await getTask(root, task.id);
    const agentReply = updated?.messages.find((m) => m.author === "agent");
    expect(agentReply?.body).toContain("Deterministic codex reply");
    expect(agentReply?.stepId).toBe("plan");
  });

  it("stores step-scoped operator notes without auto-running a turn", async () => {
    const app = createServer({ root, runner: new DeterministicAgentRunner("codex"), testMode: true });

    const created = await request(app)
      .post("/api/tasks")
      .send({ title: "Step note", description: "Check pagination.", agent: "codex", source: "manual", links: [] })
      .expect(201);
    await request(app).post(`/api/tasks/${created.body.id}/approve`).expect(200);
    await request(app).post(`/api/tasks/${created.body.id}/turn`).expect(200);

    const reply = await request(app)
      .post(`/api/tasks/${created.body.id}/messages`)
      .send({
        author: "operator",
        body: "Cover empty pages.",
        stepId: "unit",
        noteOnly: true
      })
      .expect(201);

    expect(reply.body.turn).toBeFalsy();
    const updated = await getTask(root, created.body.id);
    expect(updated?.messages.at(-1)?.stepId).toBe("unit");
    expect(updated?.turnCount).toBe(1);
  });

  it("auto-runs another turn when the operator replies on an awaiting_operator task", async () => {
    const app = createServer({ root, runner: new DeterministicAgentRunner("codex"), testMode: true });

    const created = await request(app)
      .post("/api/tasks")
      .send({ title: "Multi-turn", description: "Check follow-ups.", agent: "codex", source: "manual", links: [] })
      .expect(201);
    await request(app).post(`/api/tasks/${created.body.id}/approve`).expect(200);
    await request(app).post(`/api/tasks/${created.body.id}/turn`).expect(200);

    const afterFirst = await getTask(root, created.body.id);
    expect(afterFirst && (await taskLegacyStatus(root, afterFirst))).toBe("awaiting_operator");
    expect(afterFirst?.turnCount).toBe(1);

    const reply = await request(app)
      .post(`/api/tasks/${created.body.id}/messages`)
      .send({ author: "operator", body: "Please continue." })
      .expect(201);
    expect(reply.body.turn).toBeTruthy();

    const afterSecond = await getTask(root, created.body.id);
    expect(afterSecond?.turnCount).toBe(2);
    expect(afterSecond?.messages.filter((m) => m.author === "agent").length).toBeGreaterThanOrEqual(2);
  });

  it("auto-runs author when operator reports a post-push issue at handoff", async () => {
    const app = createServer({ root, runner: new DeterministicAgentRunner("grok"), testMode: true });
    const created = await request(app)
      .post("/api/tasks")
      .send({
        title: "Merge conflict follow-up",
        description: "Fix MR conflict.",
        workflowId: "code-feature",
        agent: "grok",
        source: "manual",
        links: []
      })
      .expect(201);

    const taskId = created.body.id as string;
    const { updateTask } = await import("../src/core/tasks/tasks.ts");
    await updateTask(root, taskId, (current) => ({
      ...current,
      pushedAt: new Date().toISOString(),
      branch: "harness/example",
      mergeRequest: {
        provider: "github",
        url: "https://github.com/example/repo/pull/1",
        number: 1
      },
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "handoff",
        completedSteps: ["plan", "plan_gate", "implement", "checks", "create_merge_request", "review", "handoff"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: new Date().toISOString() },
          implement: { stepId: "implement", status: "approved", approvedAt: new Date().toISOString() }
        }
      }
    }));

    const reply = await request(app)
      .post(`/api/tasks/${taskId}/messages`)
      .send({ author: "operator", body: "There is a merge conflict on the MR" })
      .expect(201);

    expect(reply.body.turn).toBeTruthy();
    const updated = await getTask(root, taskId);
    expect(updated?.workflowRun?.currentStepId).toBe("implement");
    expect(updated?.turnCount).toBeGreaterThan(0);
    expect(updated?.messages.some((m) => m.author === "operator" && m.body.includes("merge conflict"))).toBe(true);
  });

  it("runOperatorFollowupTurn routes blocked bugfix handoff tasks back to fix", async () => {
    const task = await createTask(root, {
      title: "Recover from handoff block",
      description: "Resolve merge conflict.",
      workflowId: "bugfix",
      agent: "grok",
      source: "manual",
      links: []
    });
    const { updateTask } = await import("../src/core/tasks/tasks.ts");
    await updateTask(root, task.id, (current) => ({
      ...current,
      blockedReason: 'No agent configured for workflow step "handoff".',
      pushedAt: new Date().toISOString(),
      workflowRun: {
        workflowId: "bugfix",
        currentStepId: "handoff",
        completedSteps: ["investigate", "plan_gate", "fix", "checks", "create_merge_request", "review", "handoff"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: new Date().toISOString() },
          fix: { stepId: "fix", status: "approved", approvedAt: new Date().toISOString() }
        }
      }
    }));

    const turn = await runOperatorFollowupTurn(root, task.id, {
      runner: new DeterministicAgentRunner("grok"),
      wait: true
    });
    expect(turn).toBeTruthy();
    const updated = await getTask(root, task.id);
    expect(updated?.workflowRun?.currentStepId).toBe("fix");
    expect(updated?.blockedReason).toBeUndefined();
  });
});
