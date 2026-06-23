import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask } from "../src/core/tasks/tasks.ts";
import { extractTargets, resolveExecutionCwd } from "../src/core/paths/targets.ts";

describe("path targets", () => {
  let homeRoot: string;

  beforeEach(async () => {
    homeRoot = await mkdtemp(path.join(tmpdir(), "harness-home-"));
  });

  afterEach(async () => {
    await rm(homeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("extracts @-tagged files and folders inside the allowed home root", async () => {
    const repo = path.join(homeRoot, "repos", "demo");
    const file = path.join(repo, "README.md");
    await mkdir(repo, { recursive: true });
    await writeFile(file, "# Demo\n", "utf8");

    const targets = await extractTargets(`Work on @${repo} and inspect @${file}.`, { homeRoot });

    expect(targets.map((target) => target.path)).toEqual([repo, file]);
    expect(targets.map((target) => target.kind)).toEqual(["directory", "file"]);
  });

  it("extracts home-relative @-tagged files and folders inside the allowed home root", async () => {
    const repo = path.join(homeRoot, "repos", "demo");
    await mkdir(repo, { recursive: true });

    const targets = await extractTargets("Work on @repos/demo", { homeRoot });

    expect(targets[0]).toMatchObject({
      raw: "@repos/demo",
      path: repo,
      kind: "directory"
    });
  });

  it("rejects @-tagged paths outside the allowed home root", async () => {
    await expect(extractTargets("Do work in @/tmp", { homeRoot })).rejects.toThrow("outside");
  });

  it("extracts backtick-quoted absolute paths from intake-style descriptions", async () => {
    const repo = path.join(homeRoot, "repos", "omniforge-app");
    await mkdir(repo, { recursive: true });

    const targets = await extractTargets(
      `Add localization to omniforge-app (\`${repo}\`) using the PR app pattern.`,
      { homeRoot }
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ path: repo, kind: "directory" });
  });

  it("stores targets on tasks and resolves an execution cwd from the first target", async () => {
    const harnessRoot = path.join(homeRoot, "codex", "harness");
    const repo = path.join(homeRoot, "repos", "demo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await ensureHarnessRepository(harnessRoot);

    const task = await createTask(harnessRoot, {
      title: "Use a repository target",
      description: `Run tests in @${repo}`,
      agent: "codex",
      source: "manual",
      links: []
    });

    expect(task.targets[0]?.path).toBe(repo);
    expect(await resolveExecutionCwd(task, { fallbackRoot: harnessRoot })).toBe(repo);
  });

  it("uses the parent directory when the first target is a file", async () => {
    const file = path.join(homeRoot, "notes", "plan.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# Plan\n", "utf8");

    const targets = await extractTargets(`Edit @${file}`, { homeRoot });
    const cwd = await resolveExecutionCwd(
      {
        targets
      },
      { fallbackRoot: homeRoot }
    );

    expect(cwd).toBe(path.dirname(file));
  });
});
