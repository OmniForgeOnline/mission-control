import { describe, expect, it } from "vitest";

import { canOpenWorktree } from "../src/ui/app/task-status.ts";
import type { HarnessTask } from "../src/ui/app/types.ts";

function task(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    id: "task-1",
    title: "T",
    description: "",
    agent: "codex",
    source: "intake",
    links: [],
    targets: [],
    messages: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides
  };
}

describe("canOpenWorktree", () => {
  it("is true for a repo-backed ticket whose worktree has not been cleaned", () => {
    expect(canOpenWorktree(task({ repoPath: "/dest/repo", branch: "harness/example" }))).toBe(true);
  });

  it("is false without a resolved repo path", () => {
    expect(canOpenWorktree(task({ branch: "harness/example" }))).toBe(false);
  });

  it("is false without a branch", () => {
    expect(canOpenWorktree(task({ repoPath: "/dest/repo" }))).toBe(false);
  });

  it("is false once the worktree has been cleaned up after merge", () => {
    expect(
      canOpenWorktree(
        task({ repoPath: "/dest/repo", branch: "harness/example", worktreeCleanedAt: "2026-06-20T00:00:00.000Z" })
      )
    ).toBe(false);
  });
});
