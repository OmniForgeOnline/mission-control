import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask, getTask, repointProjectTasks } from "../src/core/tasks/tasks.ts";
import type { HarnessTarget } from "../src/core/types.ts";

describe("repointProjectTasks", () => {
  let root: string;
  const projectId = "proj-test";
  const otherProjectId = "proj-other";
  const oldPath = "/old/repo";
  const newPath = "/new/repo";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-repoint-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    // createTask fires a background memory-capture write that can race with
    // recursive removal on APFS (ENOTEMPTY); cleanup must not fail a passing test.
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function makeTask(
    title: string,
    overrides: {
      projectId?: string;
      repoPath?: string;
      targets?: HarnessTarget[];
    } = {}
  ) {
    const repoPath = overrides.repoPath ?? oldPath;
    return createTask(root, {
      title,
      description: "desc",
      workflowId: "code-feature",
      source: "manual",
      projectId: overrides.projectId ?? projectId,
      repoPath,
      targets: overrides.targets ?? [{ raw: `@${repoPath}`, path: repoPath, kind: "directory" }]
    });
  }

  it("repoints repoPath and target paths for tasks in the project", async () => {
    const a = await makeTask("task-a");
    const b = await makeTask("task-b");

    await repointProjectTasks(root, projectId, oldPath, newPath);

    const aAfter = await getTask(root, a.id);
    const bAfter = await getTask(root, b.id);
    expect(aAfter?.repoPath).toBe(newPath);
    expect(aAfter?.targets[0]?.path).toBe(newPath);
    expect(bAfter?.repoPath).toBe(newPath);
    expect(bAfter?.targets[0]?.path).toBe(newPath);
  });

  it("leaves tasks in other projects untouched", async () => {
    const mine = await makeTask("mine", { projectId });
    const theirs = await makeTask("theirs", { projectId: otherProjectId });

    await repointProjectTasks(root, projectId, oldPath, newPath);

    const mineAfter = await getTask(root, mine.id);
    expect(mineAfter?.repoPath).toBe(newPath);

    const theirsAfter = await getTask(root, theirs.id);
    expect(theirsAfter?.repoPath).toBe(oldPath);
    expect(theirsAfter?.targets[0]?.path).toBe(oldPath);
    expect(theirsAfter?.updatedAt).toBe(theirs.updatedAt);
  });

  it("prefix-rewrites repoPath and target paths nested under the old path", async () => {
    const worktree = `${oldPath}/worktrees/feat`;
    const task = await makeTask("worktree-task", {
      repoPath: worktree,
      targets: [
        { raw: `@${worktree}`, path: worktree, kind: "directory" },
        { raw: `@${oldPath}/src/file.ts`, path: `${oldPath}/src/file.ts`, kind: "file" }
      ]
    });

    await repointProjectTasks(root, projectId, oldPath, newPath);

    const after = await getTask(root, task.id);
    expect(after?.repoPath).toBe(`${newPath}/worktrees/feat`);
    expect(after?.targets[0]?.path).toBe(`${newPath}/worktrees/feat`);
    expect(after?.targets[1]?.path).toBe(`${newPath}/src/file.ts`);
  });

  it("is idempotent on a second run", async () => {
    const task = await makeTask("once");
    await repointProjectTasks(root, projectId, oldPath, newPath);
    const afterFirst = await getTask(root, task.id);

    await repointProjectTasks(root, projectId, oldPath, newPath);

    const afterSecond = await getTask(root, task.id);
    expect(afterSecond?.updatedAt).toBe(afterFirst?.updatedAt);
  });

  it("leaves unrelated target paths unchanged", async () => {
    const task = await makeTask("mixed", {
      targets: [
        { raw: `@${oldPath}`, path: oldPath, kind: "directory" },
        { raw: "@/etc/other", path: "/etc/other", kind: "directory" }
      ]
    });

    await repointProjectTasks(root, projectId, oldPath, newPath);

    const after = await getTask(root, task.id);
    expect(after?.targets[0]?.path).toBe(newPath);
    expect(after?.targets[1]?.path).toBe("/etc/other");
  });
});
