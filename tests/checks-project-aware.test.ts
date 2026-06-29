import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import { onboardProject } from "../src/core/projects/registry.ts";
import { generateProjectQualityGate } from "../src/core/projects/quality-gate-generation.ts";
import { writeQualityGate } from "../src/core/projects/quality-gate.ts";
import { planProjectChecks } from "../src/core/projects/project-checks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

function repliesRunner(reply: string): DeterministicAgentRunner {
  const runner = new DeterministicAgentRunner("claude");
  runner.setReplies([reply]);
  return runner;
}

describe("planProjectChecks (project-aware planner)", () => {
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-pa-root-"));
    workspace = await mkdtemp(path.join(tmpdir(), "harness-pa-ws-"));
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }).catch(() => {}),
      rm(workspace, { recursive: true, force: true }).catch(() => {})
    ]);
  });

  it("delegates to workspace detection when projectId is undefined (harness-level tasks)", async () => {
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
      "utf8"
    );

    const plan = await planProjectChecks(root, undefined, workspace);
    expect(plan.source).toBe("package.json");
    expect(plan.checks.find((c) => c.name === "lint")?.available).toBe(true);
  });

  it("uses the generated gate when ready, replacing generic detection", async () => {
    const repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n[tool.pytest.ini_options]\n", "utf8");
    const project = await onboardProject(root, { repoPath: repo, name: "Py" });

    // Generate the gate; agent returns a valid ready config.
    await generateProjectQualityGate(root, project, {
      runner: repliesRunner(
        JSON.stringify({
          status: "ready",
          checks: [
            { name: "lint", category: "lint", command: "ruff check .", required: true, evidence: ["pyproject.toml [tool.ruff]"] },
            { name: "tests", category: "test", command: "pytest", required: true, evidence: ["pyproject.toml [tool.pytest]"] }
          ],
          rationale: "declared in pyproject"
        })
      )
    });

    // Workspace has a package.json (generic detection would say npm), but the
    // generated project gate must win.
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }), "utf8");

    const plan = await planProjectChecks(root, project.id, workspace);
    expect(plan.source).toBe("quality-gate");
    const cmds = plan.checks.map((c) => c.command);
    expect(cmds).toContain("ruff check .");
    expect(cmds).toContain("pytest");
    expect(cmds).not.toContain("npm run -s lint");
  });

  it("lets an explicit .harness/checks.yml override the generated gate", async () => {
    const repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    const project = await onboardProject(root, { repoPath: repo, name: "Py" });
    await generateProjectQualityGate(root, project, {
      runner: repliesRunner(
        JSON.stringify({
          status: "ready",
          checks: [{ name: "lint", category: "lint", command: "ruff check .", required: true, evidence: ["pyproject.toml [tool.ruff]"] }],
          rationale: "x"
        })
      )
    });

    await mkdir(path.join(workspace, ".harness"), { recursive: true });
    await writeFile(
      path.join(workspace, ".harness", "checks.yml"),
      "checks:\n  - name: custom\n    command: ./my-gate.sh\n",
      "utf8"
    );

    const plan = await planProjectChecks(root, project.id, workspace);
    expect(plan.source).toBe("checks.yml");
    expect(plan.checks).toEqual([{ name: "custom", command: "./my-gate.sh", available: true }]);
  });

  it("surfaces an incomplete gate as a no-blocking-checks plan, never generic detection", async () => {
    const repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    const project = await onboardProject(root, { repoPath: repo, name: "Empty" });
    // No repo evidence + invalid agent -> incomplete gate (no generic fallback).
    await generateProjectQualityGate(root, project, { runner: repliesRunner("nope") });

    // A package.json is present, but the contract forbids substituting it for an
    // incomplete gate: the project must surface its needs-resolution state.
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const plan = await planProjectChecks(root, project.id, workspace);
    expect(plan.source).toBe("quality-gate");
    expect(plan.checks).toEqual([]);
  });

  it("surfaces a failed gate as a no-blocking-checks plan, never generic detection", async () => {
    const repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    const project = await onboardProject(root, { repoPath: repo, name: "Boom" });
    await writeQualityGate(root, project.id, { status: "failed", checks: [], error: "intel gathering failed" });

    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const plan = await planProjectChecks(root, project.id, workspace);
    expect(plan.source).toBe("quality-gate");
    expect(plan.checks).toEqual([]);
  });

  it("still uses baseline detection while the gate is pending (not yet generated)", async () => {
    const repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    const project = await onboardProject(root, { repoPath: repo, name: "Fresh" });
    // No generation run yet -> pending gate -> baseline detection is the interim.
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const plan = await planProjectChecks(root, project.id, workspace);
    expect(plan.source).toBe("package.json");
    expect(plan.checks.find((c) => c.name === "test")?.available).toBe(true);
  });

  it("preserves a generated check's workingDirectory as the planned cwd", async () => {
    const repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    const project = await onboardProject(root, { repoPath: repo, name: "Py" });
    await generateProjectQualityGate(root, project, {
      runner: repliesRunner(
        JSON.stringify({
          status: "ready",
          checks: [
            {
              name: "lint",
              category: "lint",
              command: "ruff check .",
              required: true,
              evidence: ["pyproject.toml [tool.ruff]"],
              workingDirectory: "services/api"
            }
          ],
          rationale: "monorepo subdir"
        })
      )
    });

    const plan = await planProjectChecks(root, project.id, workspace);
    expect(plan.source).toBe("quality-gate");
    expect(plan.checks[0]?.cwd).toBe("services/api");
  });

  it("excludes advisory (required:false) checks from the blocking plan", async () => {
    const repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n[tool.black]\n", "utf8");
    const project = await onboardProject(root, { repoPath: repo, name: "Py" });
    await generateProjectQualityGate(root, project, {
      runner: repliesRunner(
        JSON.stringify({
          status: "ready",
          checks: [
            { name: "lint", category: "lint", command: "ruff check .", required: true, evidence: ["pyproject.toml [tool.ruff]"] },
            { name: "format", category: "format", command: "black .", required: false, evidence: ["pyproject.toml [tool.black]"] }
          ],
          rationale: "x"
        })
      )
    });

    const plan = await planProjectChecks(root, project.id, workspace);
    expect(plan.source).toBe("quality-gate");
    const cmds = plan.checks.map((c) => c.command);
    expect(cmds).toContain("ruff check .");
    expect(cmds).not.toContain("black ."); // advisory, not blocking
  });
});
