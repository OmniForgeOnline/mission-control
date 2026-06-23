import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isStuckPushedPreReviewTask,
  reconcileStuckPushedTasks
} from "../src/core/bootstrap/reconciliation.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { connectWithToken } from "../src/connectors/connections.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import type { HarnessTask } from "../src/core/types.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import { runWorkflowReconcileSweep } from "../src/autonomy/handlers/workflow-reconcile-sweep.ts";
import { runAutonomyJob } from "../src/autonomy/jobs.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

describe("reconcileStuckPushedTasks", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-reconcile-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("ignores tasks without pushedAt", async () => {
    const task = await createTask(root, {
      title: "Not pushed",
      description: "No push timestamp.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await updateTask(root, task.id, (current) => ({
      ...current,
      repoPath: "/tmp/repo",
      branch: "harness/test",
      workflowRun: {
        ...current.workflowRun!,
        currentStepId: "checks"
      }
    }));

    const result = await reconcileStuckPushedTasks(root);
    expect(result).toEqual({ scanned: 0, reconciled: 0, errors: 0 });
  });

  it("ignores non-repo-backed tasks", async () => {
    const task = await createTask(root, {
      title: "Scratch task",
      description: "No repo path.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await updateTask(root, task.id, (current) => ({
      ...current,
      pushedAt: new Date().toISOString(),
      workflowRun: {
        ...current.workflowRun!,
        currentStepId: "checks"
      }
    }));

    const workflow = await loadWorkflow(root, "code-feature");
    const updated = await getTask(root, task.id);
    expect(isStuckPushedPreReviewTask(updated!, workflow)).toBe(false);

    const result = await reconcileStuckPushedTasks(root);
    expect(result).toEqual({ scanned: 0, reconciled: 0, errors: 0 });
  });

  it("ignores tasks already at review or later", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const task = await createTask(root, {
      title: "At review",
      description: "Should not reconcile.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    const base = {
      ...task,
      pushedAt: new Date().toISOString(),
      repoPath: "/tmp/repo",
      branch: "harness/test",
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "review",
        completedSteps: [],
        stepApprovals: {}
      }
    } satisfies HarnessTask;

    expect(isStuckPushedPreReviewTask(base, workflow)).toBe(false);
    expect(
      isStuckPushedPreReviewTask(
        { ...base, workflowRun: { ...base.workflowRun, currentStepId: "handoff" } },
        workflow
      )
    ).toBe(false);
  });

  it("chains workflow for stuck pushed tasks on pre-review steps", async () => {
    await connectWithToken(root, "github", "ghp_testtoken", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-reconcile-repo-"));
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
      await exec("git", ["commit", "--allow-empty", "-m", "Harness change"], { cwd: repoDir });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes("/pulls?") && (!init || init.method === undefined)) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          if (url.endsWith("/pulls") && init?.method === "POST") {
            return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7" }), {
              status: 201
            });
          }
          return new Response("not found", { status: 404 });
        })
      );

      const task = await createTask(root, {
        title: "Stuck after push",
        description: "## Goal\nAdvance workflow.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${repoDir}`, path: repoDir, kind: "directory" }]
      });

      await updateTask(root, task.id, (current) => ({
        ...current,
        pushedAt: new Date().toISOString(),
        repoPath: repoDir,
        branch: "harness/test",
        workspacePath: repoDir,
        workflowRun: {
          ...current.workflowRun!,
          currentStepId: "create_merge_request"
        }
      }));

      const workflow = await loadWorkflow(root, "code-feature");
      const stuck = await getTask(root, task.id);
      expect(isStuckPushedPreReviewTask(stuck!, workflow)).toBe(true);

      const result = await reconcileStuckPushedTasks(root, {
        runner: new DeterministicAgentRunner("grok"),
        wait: true
      });
      expect(result).toMatchObject({ scanned: 1, reconciled: 1, errors: 0 });

      const advanced = await getTask(root, task.id);
      expect(advanced?.workflowRun?.currentStepId).toBe("review");
      expect(advanced?.mergeRequest?.number).toBe(7);
    } finally {
      vi.unstubAllGlobals();
      await rm(repoDir, { recursive: true, force: true });
    }
  }, 15000);

  it("continues scanning when one task errors", async () => {
    const first = await createTask(root, {
      title: "Will fail",
      description: "Throws during reconcile.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    const second = await createTask(root, {
      title: "Will succeed",
      description: "Spy target.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    for (const task of [first, second]) {
      await updateTask(root, task.id, (current) => ({
        ...current,
        pushedAt: new Date().toISOString(),
        repoPath: "/tmp/repo",
        branch: "harness/test",
        workflowRun: {
          ...current.workflowRun!,
          currentStepId: "create_merge_request"
        }
      }));
    }

    const spy = vi
      .spyOn(await import("../src/daemon/processor.ts"), "runTaskTurn")
      .mockImplementation(async (_root, taskId) => {
        if (taskId === first.id) throw new Error("simulated failure");
        return { runId: taskId, execution: "idle" };
      });

    const result = await reconcileStuckPushedTasks(root);
    expect(result).toEqual({ scanned: 2, reconciled: 1, errors: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("workflow-reconcile-sweep autonomy job", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-reconcile-job-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("reports when no stuck tasks are found", async () => {
    const result = await runWorkflowReconcileSweep(root);
    expect(result).toMatchObject({
      jobId: "workflow-reconcile-sweep",
      status: "completed",
      summary: "No stuck pushed tasks on pre-review workflow steps.",
      proposalsCreated: 0
    });
  });

  it("is registered in the autonomy job registry", async () => {
    const result = await runAutonomyJob(root, "workflow-reconcile-sweep");
    expect(result.jobId).toBe("workflow-reconcile-sweep");
    expect(result.status).toBe("completed");
  });
});
