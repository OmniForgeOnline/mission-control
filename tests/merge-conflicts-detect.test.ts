import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { attemptBaseMerge } from "../src/core/review/merge-conflicts.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Harness Test"]);
  await writeFile(path.join(dir, "a.txt"), "base\n", "utf8");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "init"]);
}

async function commitFile(dir: string, file: string, contents: string, message: string): Promise<void> {
  await writeFile(path.join(dir, file), contents, "utf8");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", message]);
}

async function hasMergeInProgress(dir: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

describe("attemptBaseMerge", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "harness-merge-"));
    await initRepo(repoDir);
    await git(repoDir, ["checkout", "-b", "harness/test"]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("reports up_to_date when the branch already contains the base tip", async () => {
    await commitFile(repoDir, "feature.txt", "feature\n", "feature work");

    const result = await attemptBaseMerge(repoDir, repoDir, "main");

    expect(result.status).toBe("up_to_date");
    expect(result.conflictedFiles).toEqual([]);
  });

  it("merges cleanly when the base advanced with non-overlapping changes", async () => {
    await commitFile(repoDir, "feature.txt", "feature\n", "feature work");
    await git(repoDir, ["checkout", "main"]);
    await commitFile(repoDir, "main-only.txt", "main\n", "main advance");
    await git(repoDir, ["checkout", "harness/test"]);

    const result = await attemptBaseMerge(repoDir, repoDir, "main");

    expect(result.status).toBe("merged_clean");
    expect(await hasMergeInProgress(repoDir)).toBe(false);
  });

  it("reports conflicts and leaves the merge in progress when changes overlap", async () => {
    await commitFile(repoDir, "a.txt", "feature change\n", "feature edits a.txt");
    await git(repoDir, ["checkout", "main"]);
    await commitFile(repoDir, "a.txt", "main change\n", "main edits a.txt");
    await git(repoDir, ["checkout", "harness/test"]);

    const result = await attemptBaseMerge(repoDir, repoDir, "main");

    expect(result.status).toBe("conflicted");
    expect(result.conflictedFiles).toContain("a.txt");
    expect(await hasMergeInProgress(repoDir)).toBe(true);
  });
});
