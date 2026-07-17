import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isAuthorHandoffReady } from "../src/terminal/handoff-ready.ts";

const execFileAsync = promisify(execFile);

describe("isAuthorHandoffReady", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "harness-handoff-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(path.join(dir, "README.md"), "init\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is false on main with no harness branch", async () => {
    expect(await isAuthorHandoffReady(dir)).toBe(false);
  });

  it("is false on a dirty harness branch", async () => {
    await execFileAsync("git", ["checkout", "-b", "harness/feature-abc123"], { cwd: dir });
    await writeFile(path.join(dir, "dirty.txt"), "x\n", "utf8");
    expect(await isAuthorHandoffReady(dir)).toBe(false);
  });

  it("is true when harness branch is committed, clean, and pushed", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "harness-handoff-bare-"));
    try {
      await execFileAsync("git", ["init", "--bare"], { cwd: bare });
      await execFileAsync("git", ["remote", "add", "origin", bare], { cwd: dir });
      await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: dir });

      await execFileAsync("git", ["checkout", "-b", "harness/feature-abc123"], { cwd: dir });
      await writeFile(path.join(dir, "feat.txt"), "done\n", "utf8");
      await execFileAsync("git", ["add", "."], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "feat"], { cwd: dir });
      await execFileAsync("git", ["push", "-u", "origin", "harness/feature-abc123"], { cwd: dir });

      expect(await isAuthorHandoffReady(dir)).toBe(true);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
