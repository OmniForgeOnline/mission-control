import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import request from "supertest";

import {
  processAllApprovedTasks,
  processNextApprovedTask,
  resumeTask,
  runTaskTurn
} from "../src/daemon/processor.ts";
import { createServer } from "../src/server/app.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { listRuns } from "../src/core/tasks/runs.ts";
import { connectWithToken } from "../src/connectors/connections.ts";
import {
  advanceTaskWorkflowStep,
  approveTask,
  createTask,
  getTask,
  pauseTask,
  setTaskStatus,
  updateTask
} from "../src/core/tasks/tasks.ts";
import { parseReviewerVerdict } from "../src/core/review/code-review.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";
import { isMergePending } from "../src/core/tasks/status.ts";

const execFileAsync = promisify(execFile);

class BlockingRunner implements AgentRunner {
  agent = "claude" as const;

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    request.onOutput?.(`started ${request.task.id}\n`);
    await new Promise(() => {});
    throw new Error("unreachable");
  }

  abort(): void {
    /* no-op */
  }
}

async function waitForTask(
  root: string,
  taskId: string,
  predicate: (task: NonNullable<Awaited<ReturnType<typeof getTask>>>) => boolean,
  timeoutMs = 3000
): Promise<Awaited<ReturnType<typeof getTask>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await getTask(root, taskId);
    if (task && predicate(task)) return task;
    if (Date.now() >= deadline) return task;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("workflow-driven daemon", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-wf-daemon-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("requires approval before a queued task can run", async () => {
    const runner = new DeterministicAgentRunner("codex");
    runner.setReplies(["<proposed_plan>\n# Plan\nFix the crash.\n</proposed_plan>"]);

    const task = await createTask(root, {
      title: "Needs approval",
      description: "Stay queued.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    expect((await getTask(root, task.id))?.workflowRun?.currentStepId).toBe("plan_gate");
    const queuedAfterFirst = await getTask(root, task.id);
    expect(queuedAfterFirst && (await taskLegacyStatus(root, queuedAfterFirst))).toBe("queued");

    const result = await processNextApprovedTask(root, { runner, wait: true });
    expect(result).toBeNull();
    const queuedAfterSecond = await getTask(root, task.id);
    expect(queuedAfterSecond && (await taskLegacyStatus(root, queuedAfterSecond))).toBe("queued");
  });

  it("task creation initializes workflow run", async () => {
    const task = await createTask(root, {
      title: "Code feature",
      description: "Plan and implement.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    expect(task.workflowRun?.workflowId).toBe("code-feature");
    expect(task.workflowRun?.currentStepId).toBe("plan");
    expect(await taskLegacyStatus(root, task)).toBe("approved");
  });

  it("approve then run reaches running and settles through workflow steps", async () => {
    const task = await createTask(root, {
      title: "Workflow task",
      description: "Run one turn.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });
    const updated = await getTask(root, task.id);
    expect(updated && (await taskLegacyStatus(root, updated))).toBe("awaiting_operator");
    expect(updated?.turnCount).toBe(1);
    expect(updated?.workflowRun?.currentStepId).toBe("plan");
  });

  it("starts at most one live run when the same task is triggered concurrently", async () => {
    const task = await createTask(root, {
      title: "Single flight",
      description: "Only one author process may own this task.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    const [first, second] = await Promise.all([
      runTaskTurn(root, task.id, { runner: new BlockingRunner() }),
      runTaskTurn(root, task.id, { runner: new BlockingRunner() })
    ]);

    const started = [first, second].filter(Boolean);
    expect(started).toHaveLength(1);
    expect((await listRuns(root)).filter((run) => run.taskId === task.id && run.status === "running")).toHaveLength(1);
  });

  it("operator reply from awaiting_operator starts the next turn", async () => {
    const app = createServer({ root, runner: new DeterministicAgentRunner("claude"), testMode: true });
    const created = await request(app)
      .post("/api/tasks")
      .send({
        title: "Follow-up",
        description: "Two turns.",
        workflowId: "code-feature",
        source: "manual",
        links: []
      })
      .expect(201);

    await request(app).post(`/api/tasks/${created.body.id}/turn`).expect(200);

    const message = await request(app)
      .post(`/api/tasks/${created.body.id}/messages`)
      .send({ author: "operator", body: "Please continue with tests." })
      .expect(201);

    expect(message.body.turn).toBeTruthy();
    const settled = await waitForTask(root, created.body.id, (t) => (t.turnCount ?? 0) >= 2);
    expect(settled?.turnCount).toBe(2);
  });

  it("conversation steps support interactive turn-based questions", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies([
      "What is the target repo for this change?",
      "<proposed_plan>\n# Plan\nImplement workflow refactor.\n</proposed_plan>",
      "<proposed_plan>\n# Plan\nRefactor workflow engine.\n</proposed_plan>",
      "unused"
    ]);

    const task = await createTask(root, {
      title: "Interactive planning",
      description: "Need a plan first.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    let current = await getTask(root, task.id);
    expect(current && (await taskLegacyStatus(root, current))).toBe("awaiting_operator");
    expect(current?.workflowRun?.currentStepId).toBe("plan");

    const app = createServer({ root, runner, testMode: true });
    await request(app)
      .post(`/api/tasks/${task.id}/messages`)
      .send({ author: "operator", body: "Use the harness repo." })
      .expect(201);

    current = await waitForTask(root, task.id, (t) => t.workflowRun?.currentStepId === "plan_gate");
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");
    expect(current?.messages?.some((m) => m.body.includes("Implement workflow refactor"))).toBe(true);
  });

  it("approval-required steps pause correctly", async () => {
    const runner = new DeterministicAgentRunner("codex");
    runner.setReplies(["<proposed_plan>\n# Plan\nFix the crash.\n</proposed_plan>"]);

    const task = await createTask(root, {
      title: "Bugfix",
      description: "Fix the crash.",
      workflowId: "bugfix",
      source: "manual",
      links: []
    });

    expect(await taskLegacyStatus(root, task)).toBe("approved");
    await processNextApprovedTask(root, { runner, wait: true });
    const queued = await getTask(root, task.id);
    expect(queued && (await taskLegacyStatus(root, queued))).toBe("queued");
    expect(queued?.workflowRun?.currentStepId).toBe("plan_gate");

    const approved = await approveTask(root, task.id);
    expect(await taskLegacyStatus(root, approved)).toBe("approved");
    expect(approved.workflowRun?.stepApprovals['plan_gate']?.status).toBe("approved");
  });

  it("bugfix advances from investigate through plan gate", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies([
      "Reproduced the crash in test env. Investigating root cause.",
      "<proposed_plan>\n# Root cause\nNull pointer in handler.\n</proposed_plan>"
    ]);

    const task = await createTask(root, {
      title: "Crash fix",
      description: "App crashes on save.",
      workflowId: "bugfix",
      source: "manual",
      links: []
    });

    const app = createServer({ root, runner, testMode: true });
    await processNextApprovedTask(root, { runner, wait: true });
    let current = await getTask(root, task.id);
    expect(current?.workflowRun?.currentStepId).toBe("investigate");
    expect(current && (await taskLegacyStatus(root, current))).toBe("awaiting_operator");

    await request(app).post(`/api/tasks/${task.id}/turn`).expect(200);
    current = await waitForTask(root, task.id, (t) => t.workflowRun?.currentStepId === "plan_gate");
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");
    expect(current?.messages?.some((m) => m.body.includes("Null pointer in handler"))).toBe(true);
  });

  it("approve-plan fast-forwards bugfix to the fix step", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      "Reproduced the crash in test env.",
      "<proposed_plan>\n# Root cause\nNull pointer in handler.\n</proposed_plan>",
      "Patched handler null check and added regression test."
    ]);

    const task = await createTask(root, {
      title: "Crash fix",
      description: "App crashes on save.",
      workflowId: "bugfix",
      source: "manual",
      links: []
    });

    const app = createServer({ root, runner, testMode: true });
    await processNextApprovedTask(root, { runner, wait: true });
    await request(app).post(`/api/tasks/${task.id}/turn`).expect(200);
    await waitForTask(root, task.id, (t) => t.workflowRun?.currentStepId === "plan_gate");

    let current = await getTask(root, task.id);
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");

    await request(app).post(`/api/tasks/${task.id}/approve-plan`).expect(200);

    current = await waitForTask(root, task.id, (t) => (t.turnCount ?? 0) >= 2);
    expect(current?.workflowRun?.currentStepId).not.toBe("plan_gate");
    expect(current?.workflowRun?.completedSteps).toContain("plan_gate");
    expect(current?.workflowRun?.stepApprovals['fix']?.status).toBe("approved");
    expect(current?.messages?.some((m) => m.body.includes("Operator approved the plan"))).toBe(true);
  });

  it("write-document workflow has no checks step", async () => {
    const task = await createTask(root, {
      title: "Write memo",
      description: "Draft an internal memo.",
      workflowId: "write-document",
      source: "manual",
      links: []
    });

    expect(task.workflowRun?.currentStepId).toBe("scope");
    expect(await taskLegacyStatus(root, task)).toBe("approved");
  });

  it("stop and resume preserve the resume cap", async () => {
    const task = await createTask(root, {
      title: "Resume me",
      description: "Pause and resume.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await setTaskStatus(root, task.id, "running");
    await pauseTask(root, task.id, {
      blockedReason: "Stopped by operator"
    });

    let current = await getTask(root, task.id);
    expect(current && (await taskLegacyStatus(root, current))).toBe("paused");

    const resumed = await resumeTask(root, task.id, { runner: new DeterministicAgentRunner("codex"), wait: true });
    expect(resumed?.execution).toBeDefined();
    current = await getTask(root, task.id);
    expect(current?.resumeAttempts).toBe(1);
  });

  it("approve-plan fast-forwards to the implement step", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      "<proposed_plan>\n# Plan\nAdd tests/core.test.ts.\n</proposed_plan>",
      "Added tests/core.test.ts and extended tests/quality.test.ts."
    ]);

    const task = await createTask(root, {
      title: "Quality gate: core",
      description: "Bring core domain to grade A.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    let current = await getTask(root, task.id);
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current?.messages?.some((m) => m.body.includes("Add tests/core.test.ts"))).toBe(true);

    const app = createServer({ root, runner, testMode: true });
    await request(app).post(`/api/tasks/${task.id}/approve-plan`).expect(200);

    current = await waitForTask(root, task.id, (t) => (t.turnCount ?? 0) >= 2);
    expect(current?.turnCount).toBe(2);
    expect(current?.workflowRun?.completedSteps).toContain("plan");
    expect(current?.workflowRun?.completedSteps).toContain("plan_gate");
    expect(current?.workflowRun?.stepApprovals['plan_gate']?.status).toBe("approved");
    expect(current?.description).toContain("## Plan");
    expect(current?.workflowRun?.stepApprovals['implement']?.status).toBe("approved");
    expect(current?.messages?.some((m) => m.body.includes("Operator approved the plan"))).toBe(true);
    expect(current?.messages?.some((m) => m.body.startsWith("### Planning turn 2"))).toBe(false);
    expect(current?.agentSessionConversation).toBe(false);

    const taskRuns = (await listRuns(root))
      .filter((run) => run.taskId === task.id)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    expect(taskRuns).toHaveLength(2);
    const implementRun = taskRuns[1]!;
    const prompt = await readFile(path.join(root, "data", "runs", implementRun.id, "prompt.md"), "utf8");
    expect(prompt).toContain("You are running under OmniForge Mission Control");
    expect(prompt).not.toContain("Operator did not provide a message");
  });

  it("operator replies on a planning step refine the plan instead of implementing", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies([
      "What should the plan cover first?",
      "<proposed_plan>\n# Plan\nAdd tests/core.test.ts and cover fs.ts.\n</proposed_plan>"
    ]);

    const task = await createTask(root, {
      title: "Quality gate: core",
      description: "Bring core domain to grade A.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    const app = createServer({ root, runner, testMode: true });
    await request(app)
      .post(`/api/tasks/${task.id}/messages`)
      .send({ author: "operator", body: "Include fs.ts coverage." })
      .expect(201);

    const current = await waitForTask(root, task.id, (t) => (t.turnCount ?? 0) >= 2);
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");
    expect(current?.messages?.some((m) => m.body.includes("cover fs.ts"))).toBe(true);
    expect(current?.messages?.some((m) => m.body.startsWith("### Planning turn 2"))).toBe(true);
    expect(current?.turnCount).toBe(2);
  });

  it("operator replies at plan_gate refine the plan via rewind", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies([
      "<proposed_plan>\n# Plan\nInitial plan.\n</proposed_plan>",
      "<proposed_plan>\n# Plan\nUpdated with templating and dictionary.\n</proposed_plan>"
    ]);

    const task = await createTask(root, {
      title: "Plan gate refinement",
      description: "Need a plan first.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    let current = await getTask(root, task.id);
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");

    const app = createServer({ root, runner, testMode: true });
    await request(app)
      .post(`/api/tasks/${task.id}/messages`)
      .send({ author: "operator", body: "Add templating and a language dictionary." })
      .expect(201);

    current = await waitForTask(root, task.id, (t) => (t.turnCount ?? 0) >= 2);
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");
    expect(current?.messages?.some((m) => m.body.includes("templating and dictionary"))).toBe(true);
    expect(current?.turnCount).toBe(2);
  });

  it("operator replies at implement pre-code rewinds to planning", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies([
      "<proposed_plan>\n# Plan\nInitial plan.\n</proposed_plan>",
      "<proposed_plan>\n# Plan\nUpdated with supported languages.\n</proposed_plan>"
    ]);

    const task = await createTask(root, {
      title: "Implement pre-code refinement",
      description: "Need a plan first.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    await approveTask(root, task.id);
    await runTaskTurn(root, task.id, { runner, wait: true });

    let current = await getTask(root, task.id);
    expect(current?.workflowRun?.currentStepId).toBe("implement");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");
    expect(current?.branch).toBeUndefined();

    const app = createServer({ root, runner, testMode: true });
    await request(app)
      .post(`/api/tasks/${task.id}/messages`)
      .send({ author: "operator", body: "Mention the supported languages." })
      .expect(201);

    current = await waitForTask(root, task.id, (t) => (t.turnCount ?? 0) >= 2);
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");
    expect(current?.messages?.some((m) => m.body.includes("supported languages"))).toBe(true);
    expect(current?.turnCount).toBe(2);
  });

  it("does not auto-chain conversation steps after a plan is emitted", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies([
      "<proposed_plan>\n# Scope\nAdd tests for core.\n</proposed_plan>",
      "This turn should not run automatically."
    ]);

    const task = await createTask(root, {
      title: "No auto chain",
      description: "Quality gate style task.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    let current = await getTask(root, task.id);
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");
    expect(current?.turnCount).toBe(1);
    expect(current?.messages?.some((m) => m.body.includes("Add tests for core"))).toBe(true);

    const results = await processAllApprovedTasks(root, { runner, wait: true });
    expect(results).toHaveLength(0);
    current = await getTask(root, task.id);
    expect(current?.turnCount).toBe(1);
  });

  it("agent selection still supports claude, codex, and grok", async () => {
    for (const agent of ["claude", "codex", "grok"] as const) {
      await createTask(root, {
        title: `Task for ${agent}`,
        description: "Agent support check.",
        workflowId: "code-feature",
        source: "manual",
        links: []
      });
      const summary = await processNextApprovedTask(root, {
        runner: new DeterministicAgentRunner(agent),
        wait: true
      });
      expect(summary?.runId).toBeTruthy();
      await rm(path.join(root, "data", "state", "tasks.json"), { force: true }).catch(() => {});
      await ensureHarnessRepository(root);
    }
  });

  it("branchless advance on review does not mark the task completed", async () => {
    const task = await createTask(root, {
      title: "Stuck on review",
      description: "Regression for premature completion.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    const approvedAt = new Date().toISOString();

    await updateTask(root, task.id, (current) => ({
      ...current,
      status: "awaiting_review",
      approvedAt,
      turnCount: 3,
      pushedAt: approvedAt,
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "review",
        completedSteps: ["plan", "plan_gate", "implement", "checks", "create_merge_request"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
          implement: { stepId: "implement", status: "approved", approvedAt }
        }
      }
    }));

    const first = await advanceTaskWorkflowStep(root, task.id);
    expect(first.resolution).toBeUndefined();
    expect(first.workflowRun?.currentStepId).toBe("review");
    expect(first.workflowRun?.completedSteps.filter((stepId) => stepId === "review")).toHaveLength(0);

    const second = await advanceTaskWorkflowStep(root, task.id);
    expect(second.resolution).toBeUndefined();
    expect(second.workflowRun?.currentStepId).toBe("review");
    expect(second.workflowRun?.completedSteps.filter((stepId) => stepId === "review")).toHaveLength(0);
  });

  it("approved branch advance completes terminal handoff in workflow metadata", async () => {
    const task = await createTask(root, {
      title: "Approved review",
      description: "Land on handoff with completed terminal metadata.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    const approvedAt = new Date().toISOString();

    await updateTask(root, task.id, (current) => ({
      ...current,
      status: "awaiting_review",
      approvedAt,
      turnCount: 3,
      pushedAt: approvedAt,
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "review",
        completedSteps: ["plan", "plan_gate", "implement", "checks", "create_merge_request"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
          implement: { stepId: "implement", status: "approved", approvedAt }
        }
      }
    }));

    const advanced = await advanceTaskWorkflowStep(root, task.id, "approved");

    expect(advanced.resolution).toBe("completed");
    expect(advanced.workflowRun?.currentStepId).toBe("handoff");
    expect(advanced.workflowRun?.completedSteps).toContain("review");
    expect(advanced.workflowRun?.completedSteps).toContain("handoff");
  });

  it("reviewer approval advances review to handoff and completes the task", async () => {
    const reviewerReply = `Review complete.

\`\`\`json
{"decision":"approve","summary":"Looks good.","comments":[]}
\`\`\``;
    const reviewerRunner = new DeterministicAgentRunner("codex");
    reviewerRunner.setReplies([reviewerReply]);

    const task = await createTask(root, {
      title: "Ready for review",
      description: "Ship after approval.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    const approvedAt = new Date().toISOString();

    await updateTask(root, task.id, (current) => ({
      ...current,
      status: "awaiting_review",
      approvedAt,
      turnCount: 3,
      pushedAt: approvedAt,
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "review",
        completedSteps: ["plan", "plan_gate", "implement", "checks", "create_merge_request"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
          implement: { stepId: "implement", status: "approved", approvedAt }
        }
      }
    }));

    const summary = await runTaskTurn(root, task.id, { reviewerRunner, wait: true });
    const updated = await getTask(root, task.id);

    expect(summary?.execution).toBe("idle");
    expect(updated?.resolution).toBe("completed");
    expect(updated?.workflowRun?.currentStepId).toBe("handoff");
    expect(updated?.workflowRun?.completedSteps).toContain("review");
    expect(updated?.workflowRun?.completedSteps.filter((stepId) => stepId === "review")).toHaveLength(1);
    expect(updated?.workflowRun?.completedSteps).toContain("handoff");
    expect(updated?.reviewState).toBe("approved");
  });

  it("merge request creation schedules reviewer and ends on handoff after approval", async () => {
    await connectWithToken(root, "github", "ghp_testtoken", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-wf-mr-chain-"));
    const reviewerReply = `Approved.

\`\`\`json
{"decision":"approve","summary":"Ready to merge.","comments":[]}
\`\`\``;
    const reviewerRunner = new DeterministicAgentRunner("codex");
    reviewerRunner.setReplies([reviewerReply]);
    const composeRunner = new DeterministicAgentRunner("grok");
    composeRunner.setReplies(["Title\n\nDescription body"]);

    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "Initial"], { cwd: repoDir });
      await exec("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "Mission Control change"], { cwd: repoDir });

      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/pulls?") && (!init || init.method === undefined)) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.endsWith("/pulls") && init?.method === "POST") {
          return new Response(JSON.stringify({ number: 42, html_url: "https://github.com/o/r/pull/42" }), {
            status: 201
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchImpl);

      const task = await createTask(root, {
        title: "MR chain task",
        description: "Exercise MR → review → handoff.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${repoDir}`, path: repoDir, kind: "directory" }]
      });

      await updateTask(root, task.id, (current) => ({
        ...current,
        workflowRun: {
          ...current.workflowRun!,
          currentStepId: "create_merge_request"
        },
        repoPath: repoDir,
        branch: "harness/test",
        workspacePath: repoDir,
        pushedAt: new Date().toISOString(),
        status: "approved",
        turnCount: 3
      }));

      const summary = await runTaskTurn(root, task.id, {
        runner: composeRunner,
        reviewerRunner,
        wait: true
      });
      const updated = await getTask(root, task.id);

      expect(summary?.execution).toBe("idle");
      // The MR is open (not merged), so reviewer approval must not mark the task
      // completed; it stays unresolved and awaiting merge until the sweep confirms it.
      expect(updated?.resolution).toBeUndefined();
      expect(updated?.completedAt).toBeUndefined();
      expect(isMergePending(updated!)).toBe(true);
      expect(updated?.workflowRun?.currentStepId).toBe("handoff");
      expect(updated?.mergeRequest?.number).toBe(42);
      expect(updated?.workflowRun?.completedSteps.filter((stepId) => stepId === "review")).toHaveLength(1);
      expect(updated?.workflowRun?.completedSteps).toContain("handoff");
    } finally {
      vi.unstubAllGlobals();
      await rm(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("self-heals review with missing merge request by reopening create_merge_request", async () => {
    await connectWithToken(root, "github", "ghp_testtoken", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-wf-mr-selfheal-"));
    const reviewerReply = `Approved.

\`\`\`json
{"decision":"approve","summary":"Ready to merge.","comments":[]}
\`\`\``;
    const reviewerRunner = new DeterministicAgentRunner("codex");
    reviewerRunner.setReplies([reviewerReply]);
    const composeRunner = new DeterministicAgentRunner("grok");
    composeRunner.setReplies(["Title\n\nDescription body"]);

    try {
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "Initial"], { cwd: repoDir });
      await exec("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "Mission Control change"], { cwd: repoDir });

      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/pulls?") && (!init || init.method === undefined)) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.endsWith("/pulls") && init?.method === "POST") {
          return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7" }), {
            status: 201
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchImpl);

      const task = await createTask(root, {
        title: "Review missing MR",
        description: "create_merge_request marked complete without persisted metadata.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${repoDir}`, path: repoDir, kind: "directory" }]
      });

      const approvedAt = new Date().toISOString();
      await updateTask(root, task.id, (current) => ({
        ...current,
        status: "approved",
        approvedAt,
        pushedAt: approvedAt,
        repoPath: repoDir,
        branch: "harness/test",
        workspacePath: repoDir,
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "review",
          completedSteps: ["plan", "plan_gate", "implement", "checks", "create_merge_request"],
          stepApprovals: {
            plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
            implement: { stepId: "implement", status: "approved", approvedAt }
          }
        },
        turnCount: 3
      }));

      const summary = await runTaskTurn(root, task.id, {
        runner: composeRunner,
        reviewerRunner,
        wait: true
      });
      const updated = await getTask(root, task.id);

      expect(summary?.execution).toBe("idle");
      expect(updated?.blockedReason).toBeUndefined();
      expect(updated?.mergeRequest?.number).toBe(7);
      // The self-healed MR is open, so approval must not complete the task.
      expect(updated?.resolution).toBeUndefined();
      expect(updated?.completedAt).toBeUndefined();
      expect(isMergePending(updated!)).toBe(true);
      expect(updated?.workflowRun?.currentStepId).toBe("handoff");
      expect(updated?.workflowRun?.completedSteps.filter((stepId) => stepId === "review")).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("advances implement after a pushed branch even without done/shipped keywords", async () => {
    const destinationRepo = await mkdtemp(path.join(tmpdir(), "harness-wf-repo-"));
    const bareRemote = path.join(root, "remote.git");

    try {
      await execFileAsync("git", ["init"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: destinationRepo });
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: destinationRepo });
      await execFileAsync("git", ["branch", "-M", "main"], { cwd: destinationRepo });
      await execFileAsync("git", ["init", "--bare", bareRemote]);
      await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
      await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });

      const task = await createTask(root, {
        title: "Quality gate: core",
        description: "Add tests.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
      });

      const branch = `harness/${task.id.replace(/-/g, "").slice(0, 12)}`;
      const handoffReply = `**Pushed.** ${branch} · 1 commit(s) · add tests/core.test.ts.

**Verified.** npm test (all pass).

**Open.** None.

**Watch.** None.

**Next.** Reviewer: confirm the push.`;

      const runner = {
        agent: "grok" as const,
        abort() {},
        async runTurn(request: { cwd: string }) {
          await mkdir(path.join(request.cwd, "tests"), { recursive: true });
          await writeFile(path.join(request.cwd, "tests", "core.test.ts"), "export {}\n", "utf8");
          await execFileAsync("git", ["add", "."], { cwd: request.cwd });
          await execFileAsync("git", ["commit", "-m", "test: add core coverage"], { cwd: request.cwd });
          await execFileAsync("git", ["push", "-u", "origin", "HEAD"], { cwd: request.cwd });
          return {
            reply: handoffReply,
            exitCode: 0,
            command: "fake-grok",
            rawLog: ""
          };
        }
      };
      const approvedAt = new Date().toISOString();

      await updateTask(root, task.id, (current) => ({
        ...current,
        status: "approved",
        approvedAt,
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "implement",
          completedSteps: ["plan", "plan_gate"],
          stepApprovals: {
            plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
            implement: { stepId: "implement", status: "approved", approvedAt }
          }
        },
        turnCount: 2
      }));

      await runTaskTurn(root, task.id, { runner, wait: true });

      const updated = await getTask(root, task.id);
      expect(updated?.workflowRun?.currentStepId).not.toBe("implement");
      expect(updated?.workflowRun?.completedSteps).toContain("implement");
    } finally {
      await rm(destinationRepo, { recursive: true, force: true });
    }
  });

  it("re-runs implement when the author claims completion without committing and pushing", async () => {
    const destinationRepo = await mkdtemp(path.join(tmpdir(), "harness-wf-commit-fail-"));
    const bareRemote = path.join(root, "remote-commit-fail.git");

    try {
      await execFileAsync("git", ["init"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: destinationRepo });
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: destinationRepo });
      await execFileAsync("git", ["branch", "-M", "main"], { cwd: destinationRepo });
      await execFileAsync("git", ["init", "--bare", bareRemote]);
      await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
      await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });

      const hookDir = path.join(destinationRepo, ".git", "hooks");
      await mkdir(hookDir, { recursive: true });
      const hookPath = path.join(hookDir, "pre-commit");
      await writeFile(
        hookPath,
        "#!/bin/sh\nif [ -f .commit-blocker ]; then\n  echo 'error: remove .commit-blocker'\n  exit 1\nfi\nexit 0\n",
        "utf8"
      );
      await chmod(hookPath, 0o755);

      const task = await createTask(root, {
        title: "Quality gate: runtime",
        description: "Add tests.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
      });

      let turn = 0;
      const runner = {
        agent: "grok" as const,
        abort() {},
        async runTurn(request: { cwd: string; prompt: string }) {
          turn += 1;
          await mkdir(path.join(request.cwd, "tests"), { recursive: true });
          if (turn === 1) {
            await writeFile(path.join(request.cwd, "tests", "runtime.test.ts"), "export {}\n", "utf8");
            await writeFile(path.join(request.cwd, ".commit-blocker"), "block\n", "utf8");
            return {
              reply: "**Pushed.** harness/test · add tests/runtime.test.ts",
              exitCode: 0,
              command: "fake-grok",
              rawLog: ""
            };
          }
          await rm(path.join(request.cwd, ".commit-blocker"), { force: true });
          await execFileAsync("git", ["add", "."], { cwd: request.cwd });
          await execFileAsync("git", ["commit", "-m", "test: add runtime coverage"], { cwd: request.cwd });
          await execFileAsync("git", ["push", "-u", "origin", "HEAD"], { cwd: request.cwd });
          return {
            reply: "**Pushed.** harness/test · add tests/runtime.test.ts",
            exitCode: 0,
            command: "fake-grok",
            rawLog: ""
          };
        }
      };
      const approvedAt = new Date().toISOString();

      await updateTask(root, task.id, (current) => ({
        ...current,
        status: "approved",
        approvedAt,
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "implement",
          completedSteps: ["plan", "plan_gate"],
          stepApprovals: {
            plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
            implement: { stepId: "implement", status: "approved", approvedAt }
          }
        },
        turnCount: 2
      }));

      await runTaskTurn(root, task.id, { runner, wait: true });

      const updated = await getTask(root, task.id);
      expect(updated?.messages?.some((m) => m.body.includes("Author handoff did not satisfy the repo contract"))).toBe(true);
      expect(updated?.messages?.some((m) => m.body.includes("Harness committed and pushed"))).toBe(false);
      expect(updated?.turnCount).toBeGreaterThanOrEqual(4);
      expect(updated?.workflowRun?.currentStepId).not.toBe("implement");
      expect(updated?.blockedReason ?? "").not.toContain("Harness commit blocked");
    } finally {
      await rm(destinationRepo, { recursive: true, force: true });
    }
  });

  it("blocks after repeated author handoffs leave uncommitted work instead of committing for the agent", async () => {
    const destinationRepo = await mkdtemp(path.join(tmpdir(), "harness-author-owned-repo-"));
    const bareRemote = path.join(root, "remote-author-owned.git");
    try {
      await execFileAsync("git", ["init"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: destinationRepo });
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: destinationRepo });
      await execFileAsync("git", ["branch", "-M", "main"], { cwd: destinationRepo });
      await execFileAsync("git", ["init", "--bare", bareRemote]);
      await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
      await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });

      const task = await createTask(root, {
        title: "Agent owns commit",
        description: "Change code and push it.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
      });

      let turns = 0;
      const runner = {
        agent: "grok" as const,
        abort() {},
        async runTurn(request: { cwd: string }) {
          turns += 1;
          await writeFile(path.join(request.cwd, `feature-${turns}.txt`), "dirty work\n", "utf8");
          return {
            reply: "**Pushed.** harness/test · done.",
            exitCode: 0,
            command: "fake-grok",
            rawLog: ""
          };
        }
      };
      const approvedAt = new Date().toISOString();
      await updateTask(root, task.id, (current) => ({
        ...current,
        status: "approved",
        approvedAt,
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "implement",
          completedSteps: ["plan", "plan_gate"],
          stepApprovals: {
            plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
            implement: { stepId: "implement", status: "approved", approvedAt }
          }
        }
      }));

      await runTaskTurn(root, task.id, { runner, wait: true });

      const updated = await getTask(root, task.id);
      expect(turns).toBeGreaterThan(1);
      expect(updated?.blockedReason).toContain("Author handoff failed after");
      expect(updated?.lastCheckFailure).toContain("Uncommitted changes remain");
      expect(updated?.workflowRun?.currentStepId).toBe("implement");

      const remoteRefs = await execFileAsync("git", ["show-ref", "--heads"], { cwd: bareRemote });
      expect(remoteRefs.stdout).not.toContain("harness/agent-owns-commit");
    } finally {
      await rm(destinationRepo, { recursive: true, force: true });
    }
  });

  it("routes reviewer request_changes with multiline evidence to implement instead of blocking", async () => {
    const reviewerReply = await readFile(
      path.join(import.meta.dirname, "fixtures/reviewer-verdict-multiline-evidence.md"),
      "utf8"
    );
    expect(parseReviewerVerdict(reviewerReply).decision).toBe("changes_requested");

    const runner = new DeterministicAgentRunner("codex");
    runner.setReplies([
      reviewerReply,
      "**Remediation.** Fixed locale coverage and reconnect sentinel handling."
    ]);

    const task = await createTask(root, {
      title: "Localization follow-up",
      description: "Address reviewer findings.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    const approvedAt = new Date().toISOString();
    await updateTask(root, task.id, (current) => ({
      ...current,
      status: "approved",
      approvedAt,
      reviewRounds: 0,
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "review",
        completedSteps: ["plan", "plan_gate", "implement", "lint", "unit", "typecheck", "create_merge_request"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
          implement: { stepId: "implement", status: "approved", approvedAt }
        }
      },
      messages: [
        {
          id: "author-push",
          author: "agent",
          body: "**Pushed.** harness/test · 1 commit(s) · localization wiring.",
          createdAt: approvedAt
        }
      ],
      turnCount: 3
    }));

    const summary = await runTaskTurn(root, task.id, { runner, reviewerRunner: runner, wait: true });
    const updated = await getTask(root, task.id);

    expect(summary?.execution).not.toBe("blocked");
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.blockedReason ?? "").not.toContain("unclear verdict");
    expect(updated?.reviewState).toBe("changes_requested");
    expect(updated?.workflowRun?.currentStepId).toBe("implement");
    expect(updated?.messages?.some((m) => m.body.includes("Reviewer asked for changes"))).toBe(true);
  });
});
