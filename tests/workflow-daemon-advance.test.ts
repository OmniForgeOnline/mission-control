import { readFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";

import {
  processNextApprovedTask,
  resumeTask,
  runTaskTurn
} from "../src/daemon/processor.ts";
import { createServer } from "../src/server/app.ts";
import {
  approveTask,
  createTask,
  getTask,
  pauseTask,
  setTaskStatus,
  updateTask
} from "../src/core/tasks/tasks.ts";
import { parseReviewerVerdict } from "../src/core/review/code-review.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";
import { rmRoot } from "./helpers/rm-root.ts";
import { createWorkflowDaemonRoot, waitForTask } from "./helpers/workflow-daemon-helpers.ts";

describe("workflow-driven daemon", () => {
  let root: string;

  beforeEach(async () => {
    root = await createWorkflowDaemonRoot();
  });

  afterEach(async () => {
    await rmRoot(root);
  });

  it("approval-required steps pause correctly", async () => {
    const runner = new DeterministicAgentRunner("codex");
    runner.setReplies([
      "<proposed_plan>\n# Plan\nFix the crash.\n## Reproduction\nReproduce locally.\n## Root Cause\nNull deref.\n## Evidence\nStack trace.\n## Affected Surface\nhandler.\n## Test Strategy\nRegression test.\n## Confidence\nhigh\n</proposed_plan>"
    ]);

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
      "<proposed_plan>\n# Root cause\nNull pointer in handler.\n## Reproduction\nRepro route.\n## Root Cause\nNull pointer in handler.\n## Evidence\nStack trace line 42.\n## Affected Surface\nhandler.\n## Test Strategy\nRegression test.\n## Confidence\nhigh\n</proposed_plan>"
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
      "<proposed_plan>\n# Root cause\nNull pointer in handler.\n## Reproduction\nRepro route.\n## Root Cause\nNull pointer in handler.\n## Evidence\nStack trace line 42.\n## Affected Surface\nhandler.\n## Test Strategy\nRegression test.\n## Confidence\nhigh\n</proposed_plan>",
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
