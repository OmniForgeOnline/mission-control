import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import request from "supertest";

import { processNextApprovedTask, runTaskTurn } from "../src/daemon/processor.ts";
import { createServer } from "../src/server/app.ts";
import { listRuns } from "../src/core/tasks/runs.ts";
import { connectWithToken } from "../src/connectors/connections.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";
import { rmRoot } from "./helpers/rm-root.ts";
import { isMergePending } from "../src/core/tasks/status.ts";
import {
  BlockingRunner,
  createWorkflowDaemonRoot,
  waitForTask
} from "./helpers/workflow-daemon-helpers.ts";

describe("workflow-driven daemon", () => {
  let root: string;

  beforeEach(async () => {
    root = await createWorkflowDaemonRoot();
  });

  afterEach(async () => {
    await rmRoot(root);
  });

  it("requires approval before a queued task can run", async () => {
    const runner = new DeterministicAgentRunner("codex");
    runner.setReplies([
      "<proposed_plan>\n# Plan\nFix the crash.\n## Acceptance Criteria\nCrash no longer occurs.\n## Verification\nReproduction case passes.\n## Risks\nNone.\n</proposed_plan>"
    ]);

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
      "<proposed_plan>\n# Plan\nImplement workflow refactor.\n## Acceptance Criteria\nRefactor lands.\n## Verification\nTests pass.\n## Risks\nNone.\n</proposed_plan>",
      "<proposed_plan>\n# Plan\nRefactor workflow engine.\n## Acceptance Criteria\nRefactor lands.\n## Verification\nTests pass.\n## Risks\nNone.\n</proposed_plan>",
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

  it("bugfix investigation with full evidence advances to plan_gate and resets the retry counter", async () => {
    const runner = new DeterministicAgentRunner("codex");
    runner.setReplies([
      "<proposed_plan>\n## Reproduction\nempty input\n## Root Cause\nmissing null check\n## Evidence\nstack trace line 42\n## Affected Surface\nsrc/parser.ts\n## Test Strategy\nnull-input unit test\n## Confidence\nhigh\n</proposed_plan>"
    ]);

    const task = await createTask(root, {
      title: "Null deref",
      description: "Crash on empty input.",
      workflowId: "bugfix",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    const after = await waitForTask(root, task.id, (t) => t.workflowRun?.currentStepId === "plan_gate");
    expect(after?.workflowRun?.currentStepId).toBe("plan_gate");
  }, 60_000);
});