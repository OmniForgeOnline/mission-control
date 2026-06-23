import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import request from "supertest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  REPO_BINDING_BLOCKED_REASON,
  bindTaskRepoTarget,
  harnessDefaultGitTargets,
  isRepoBindingBlockedReason,
  resolveTargetsForGitWorkflow,
  taskNeedsRepoBinding
} from "../src/core/tasks/repo-binding.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import { runTaskTurn } from "../src/daemon/processor.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import { createServer } from "../src/server/app.ts";
import { clearInflightTurn, registerInflightTurn } from "../src/runtime/sessions.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

const exec = promisify(execFile);

describe("repo binding", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-repo-bind-"));
    await ensureHarnessRepository(root);
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await exec("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });
  });

  afterEach(async () => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      /* temp cleanup best-effort */
    }
  });

  it("detects repo-binding blocked reasons", () => {
    expect(isRepoBindingBlockedReason(REPO_BINDING_BLOCKED_REASON)).toBe(true);
    expect(isRepoBindingBlockedReason("Merge request creation failed")).toBe(false);
  });

  it("defaults git workflow targets to the harness root when none are extracted", async () => {
    const workflow = await loadWorkflow(root, "frontend-ui-change");
    const targets = await resolveTargetsForGitWorkflow(root, workflow, []);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.path).toBe(await realpath(root));
    expect(targets[0]?.kind).toBe("directory");
  });

  it("creates intake git workflow tasks with harness repo target by default", async () => {
    const task = await createTask(root, {
      title: "UI tweak",
      description: "Adjust modal copy in harness UI.",
      workflowId: "frontend-ui-change",
      source: "intake"
    });
    expect(task.targets).toHaveLength(1);
    expect(task.targets[0]?.path).toBe(await realpath(root));
  });

  it("bindTaskRepoTarget persists a git directory target and clears stale git fields", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-bind-repo-"));
    try {
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });

      const task = await createTask(root, {
        title: "Needs binding",
        description: "No repo yet.",
        workflowId: "code-feature",
        source: "manual",
        targets: []
      });

      await updateTask(root, task.id, (current) => ({
        ...current,
        blockedReason: REPO_BINDING_BLOCKED_REASON,
        repoPath: "/stale/repo",
        branch: "harness/stale",
        pushedAt: new Date().toISOString(),
        mergeRequest: { provider: "github", url: "https://example.com/pull/1", number: 1 }
      }));

      const bound = await bindTaskRepoTarget(root, task.id, repoDir);
      expect(bound.targets[0]?.path).toBe(await realpath(repoDir));
      expect(bound.blockedReason).toBeUndefined();
      expect(bound.repoPath).toBeUndefined();
      expect(bound.branch).toBeUndefined();
      expect(bound.pushedAt).toBeUndefined();
      expect(bound.mergeRequest).toBeUndefined();
      expect(bound.messages?.some((m) => m.author === "system" && m.body.includes("Repository bound"))).toBe(true);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("taskNeedsRepoBinding is true for git workflows on post-push steps without targets", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const task = await createTask(root, {
      title: "Scratch",
      description: "No paths.",
      workflowId: "code-feature",
      source: "manual",
      targets: []
    });
    await updateTask(root, task.id, (current) => ({
      ...current,
      workflowRun: { ...current.workflowRun!, currentStepId: "create_merge_request" }
    }));
    const updated = (await getTask(root, task.id))!;
    expect(taskNeedsRepoBinding(updated, workflow)).toBe(true);
  });

  it("blocks create_merge_request for non-repo tasks instead of skipping to review", async () => {
    const task = await createTask(root, {
      title: "Scratch task",
      description: "No repo.",
      workflowId: "code-feature",
      source: "manual",
      targets: []
    });

    await updateTask(root, task.id, (current) => ({
      ...current,
      workflowRun: { ...current.workflowRun!, currentStepId: "create_merge_request" }
    }));

    const summary = await runTaskTurn(root, task.id);
    const updated = await getTask(root, task.id);
    expect(summary?.execution).toBe("blocked");
    expect(updated?.blockedReason).toBe(REPO_BINDING_BLOCKED_REASON);
    expect(updated?.workflowRun?.currentStepId).toBe("create_merge_request");
    expect(updated?.mergeRequest).toBeUndefined();
  });

  it("POST /api/tasks/:id/bind-repo binds a repository and resumes a blocked MR step", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-bind-api-"));
    try {
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });
      await exec("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: repoDir });

      const task = await createTask(root, {
        title: "API bind",
        description: "Needs repo binding.",
        workflowId: "code-feature",
        source: "manual",
        targets: []
      });
      await updateTask(root, task.id, (current) => ({
        ...current,
        workflowRun: { ...current.workflowRun!, currentStepId: "create_merge_request" },
        blockedReason: REPO_BINDING_BLOCKED_REASON
      }));

      const app = createServer({ root });
      const response = await request(app)
        .post(`/api/tasks/${task.id}/bind-repo`)
        .send({ path: repoDir })
        .expect(200);

      expect(response.body.task.targets[0]?.path).toBe(await realpath(repoDir));
      expect(response.body.task.blockedReason).toBeUndefined();
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("POST /api/tasks/:id/bind-repo rejects running tasks", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-bind-running-"));
    let taskId: string | undefined;
    try {
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });

      const task = await createTask(root, {
        title: "Running bind",
        description: "Cannot switch project mid-run.",
        workflowId: "code-feature",
        source: "manual",
        targets: []
      });
      taskId = task.id;
      registerInflightTurn(task.id, new DeterministicAgentRunner("codex"));

      const app = createServer({ root });
      await request(app)
        .post(`/api/tasks/${task.id}/bind-repo`)
        .send({ path: repoDir })
        .expect(409);
      clearInflightTurn(task.id);
    } finally {
      if (taskId) clearInflightTurn(taskId);
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("harnessDefaultGitTargets returns empty for non-git directories", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-not-git-"));
    try {
      const targets = await harnessDefaultGitTargets(dir);
      expect(targets).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
