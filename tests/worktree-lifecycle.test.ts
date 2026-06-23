import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { connectWithToken } from "../src/connectors/connections.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import type { HarnessTask } from "../src/core/types.ts";
import { cleanupMergedTaskWorktrees } from "../src/core/worktrees/lifecycle.ts";
import { worktreePathFor } from "../src/core/worktrees/worktrees.ts";

const execFileAsync = promisify(execFile);

describe("worktree lifecycle", () => {
  let root: string;
  let destinationRepo: string;
  let bareRemote: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-wt-life-"));
    destinationRepo = await mkdtemp(path.join(tmpdir(), "harness-wt-life-repo-"));
    bareRemote = path.join(root, "remote.git");
    await ensureHarnessRepository(root);

    await execFileAsync("git", ["init"], { cwd: destinationRepo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: destinationRepo });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: destinationRepo });
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: destinationRepo });
    await execFileAsync("git", ["branch", "-M", "main"], { cwd: destinationRepo });
    await execFileAsync("git", ["init", "--bare", bareRemote]);
    await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });

    await connectWithToken(root, "github", "ghp_testtoken", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/pulls/3")) {
          return new Response(JSON.stringify({ state: "closed", merged: true }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
    await rm(destinationRepo, { recursive: true, force: true });
  });

  it("removes worktrees after the merge request is merged", async () => {
    const task = await createTask(root, {
      title: "Merged feature",
      description: "Cleanup after merge.",
      workflowId: "code-feature",
      source: "manual",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });

    const branch = `harness/${task.id.replace(/-/g, "").slice(0, 12)}`;
    const worktreeDir = worktreePathFor(root, task);
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreeDir, "main"], { cwd: destinationRepo });
    await mkdir(path.join(worktreeDir, "tests"), { recursive: true });
    await writeFile(path.join(worktreeDir, "tests", "core.test.ts"), "export {}\n", "utf8");
    await execFileAsync("git", ["add", "tests/core.test.ts"], { cwd: worktreeDir });
    await execFileAsync("git", ["commit", "-m", "add tests"], { cwd: worktreeDir });
    await execFileAsync("git", ["push", "-u", "origin", branch], { cwd: worktreeDir });

    await execFileAsync(
      "git",
      ["remote", "set-url", "origin", "https://github.com/octocat/hello-world.git"],
      { cwd: destinationRepo }
    );

    await updateTask(root, task.id, (current) => ({
      ...current,
      repoPath: destinationRepo,
      branch,
      status: "completed",
      mergeRequest: {
        provider: "github",
        url: "https://github.com/octocat/hello-world/pull/3",
        number: 3
      }
    }));

    const candidate = (await getTask(root, task.id))!;
    const results = await cleanupMergedTaskWorktrees(root, [candidate]);
    expect(results).toEqual([
      expect.objectContaining({ taskId: task.id, cleaned: true })
    ]);

    const updated = await getTask(root, task.id);
    expect(updated?.worktreeCleanedAt).toBeTruthy();
    await expect(access(worktreeDir)).rejects.toThrow();
  });

  it("removes orphan worktrees that have no matching task", async () => {
    const orphanId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const worktreeDir = worktreePathFor(root, { id: orphanId } as HarnessTask);
    const branch = `harness/${orphanId.replace(/-/g, "").slice(0, 12)}`;
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreeDir, "main"], { cwd: destinationRepo });

    const results = await cleanupMergedTaskWorktrees(root, []);

    expect(results).toEqual([
      expect.objectContaining({
        taskId: orphanId.replace(/-/g, "").slice(0, 12),
        cleaned: true,
        reason: "orphan worktree removed"
      })
    ]);
    await expect(access(worktreeDir)).rejects.toThrow();
  });

  it("backfills mergeRequest from branch lookup and cleans after merge", async () => {
    const task = await createTask(root, {
      title: "Manual PR",
      description: "PR opened outside workflow.",
      workflowId: "code-feature",
      source: "manual",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });

    const branch = `harness/${task.id.replace(/-/g, "").slice(0, 12)}`;
    const worktreeDir = worktreePathFor(root, task);
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreeDir, "main"], { cwd: destinationRepo });
    await execFileAsync(
      "git",
      ["remote", "set-url", "origin", "https://github.com/octocat/hello-world.git"],
      { cwd: destinationRepo }
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/pulls?head=")) {
          return new Response(
            JSON.stringify([{ number: 7, html_url: "https://github.com/octocat/hello-world/pull/7", state: "closed", merged: true }]),
            { status: 200 }
          );
        }
        if (url.endsWith("/pulls/7")) {
          return new Response(JSON.stringify({ state: "closed", merged: true }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const pushedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await updateTask(root, task.id, (current) => ({
      ...current,
      repoPath: destinationRepo,
      branch,
      pushedAt,
      status: "awaiting_operator"
    }));

    const candidate = (await getTask(root, task.id))!;
    const results = await cleanupMergedTaskWorktrees(root, [candidate]);

    expect(results).toEqual([expect.objectContaining({ taskId: task.id, cleaned: true })]);
    const updated = await getTask(root, task.id);
    expect(updated?.mergeRequest).toMatchObject({
      provider: "github",
      number: 7,
      url: "https://github.com/octocat/hello-world/pull/7"
    });
    await expect(access(worktreeDir)).rejects.toThrow();
  });

  it("removes worktrees for terminal tasks after the grace period", async () => {
    const task = await createTask(root, {
      title: "Done feature",
      description: "Completed without merge request metadata.",
      workflowId: "code-feature",
      source: "manual",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });

    const branch = `harness/${task.id.replace(/-/g, "").slice(0, 12)}`;
    const worktreeDir = worktreePathFor(root, task);
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreeDir, "main"], { cwd: destinationRepo });

    const completedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await updateTask(root, task.id, (current) => ({
      ...current,
      repoPath: destinationRepo,
      branch,
      status: "completed",
      completedAt
    }));

    const candidate = (await getTask(root, task.id))!;
    const results = await cleanupMergedTaskWorktrees(root, [candidate]);

    expect(results).toEqual([
      expect.objectContaining({ taskId: task.id, cleaned: true, reason: "terminal task worktree removed" })
    ]);
    await expect(access(worktreeDir)).rejects.toThrow();
  });
});

async function access(filePath: string): Promise<void> {
  const { access: fsAccess } = await import("node:fs/promises");
  return fsAccess(filePath);
}