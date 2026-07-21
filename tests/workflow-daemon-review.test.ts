import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import {
  processAllApprovedTasks,
  processNextApprovedTask,
  runTaskTurn
} from "../src/daemon/processor.ts";
import { createServer } from "../src/server/app.ts";
import { listRuns } from "../src/core/tasks/runs.ts";
import { connectWithToken } from "../src/connectors/connections.ts";
import {
  approveTask,
  createTask,
  getTask,
  updateTask
} from "../src/core/tasks/tasks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";
import { rmRoot } from "./helpers/rm-root.ts";
import { isMergePending } from "../src/core/tasks/status.ts";
import {
  createWorkflowDaemonRoot,
  execFileAsync,
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

  it("approve-plan fast-forwards to the implement step", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      "<proposed_plan>\n# Plan\nAdd tests/core.test.ts.\n## Acceptance Criteria\nTests exist.\n## Verification\nRun the suite.\n## Risks\nNone.\n</proposed_plan>",
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
      "<proposed_plan>\n# Plan\nAdd tests/core.test.ts and cover fs.ts.\n## Acceptance Criteria\nCoverage lands.\n## Verification\nRun tests.\n## Risks\nNone.\n</proposed_plan>"
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
      "<proposed_plan>\n# Plan\nInitial plan.\n## Acceptance Criteria\nPlan accepted.\n## Verification\nReview.\n## Risks\nNone.\n</proposed_plan>",
      "<proposed_plan>\n# Plan\nUpdated with templating and dictionary.\n## Acceptance Criteria\nPlan accepted.\n## Verification\nReview.\n## Risks\nNone.\n</proposed_plan>"
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
      "<proposed_plan>\n# Plan\nInitial plan.\n## Acceptance Criteria\nPlan accepted.\n## Verification\nReview.\n## Risks\nNone.\n</proposed_plan>",
      "<proposed_plan>\n# Plan\nUpdated with supported languages.\n## Acceptance Criteria\nPlan accepted.\n## Verification\nReview.\n## Risks\nNone.\n</proposed_plan>"
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
      "<proposed_plan>\n# Scope\nAdd tests for core.\n## Acceptance Criteria\nTests exist.\n## Verification\nRun them.\n## Risks\nNone.\n</proposed_plan>",
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
});
