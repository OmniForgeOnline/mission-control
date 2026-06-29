import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { onboardProject, type ProjectRecord } from "../src/core/projects/registry.ts";
import { gatherProjectIntel } from "../src/core/projects/intel.ts";
import {
  parseAndValidateQualityGate,
  readProjectQualityGate,
  synthesizeGateFromIntel,
  writeQualityGate
} from "../src/core/projects/quality-gate.ts";
import { generateProjectQualityGate } from "../src/core/projects/quality-gate-generation.ts";
import { planProjectChecks } from "../src/core/projects/project-checks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

function repliesRunner(reply: string): DeterministicAgentRunner {
  const runner = new DeterministicAgentRunner("claude");
  runner.setReplies([reply]);
  return runner;
}

const READY_RUFF = JSON.stringify({
  status: "ready",
  checks: [
    {
      name: "lint",
      category: "lint",
      command: "ruff check .",
      required: true,
      evidence: ["pyproject.toml [tool.ruff]"]
    }
  ],
  rationale: "Ruff is declared in pyproject.toml."
});

describe("synthesizeGateFromIntel", () => {
  it("builds a ready config from evidence-backed commands, carrying the source as evidence", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-qg-synth-"));
    try {
      await writeFile(
        path.join(tmp, "pyproject.toml"),
        "[tool.pytest.ini_options]\n[tool.ruff]\n",
        "utf8"
      );
      const intel = await gatherProjectIntel(tmp);
      const file = synthesizeGateFromIntel(intel);

      expect(file.status).toBe("ready");
      expect(file.checks.length).toBe(2);
      const ruff = file.checks.find((c) => c.command === "ruff check .");
      expect(ruff?.category).toBe("lint");
      expect(ruff?.evidence).toContain("pyproject.toml [tool.ruff]");
      expect(file.intel).toBe(intel);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns incomplete (never a generic gate) when no evidence was found", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-qg-empty-"));
    try {
      const intel = await gatherProjectIntel(tmp);
      const file = synthesizeGateFromIntel(intel);
      expect(file.status).toBe("incomplete");
      expect(file.checks).toEqual([]);
      expect(file.needsResolution?.length).toBeGreaterThan(0);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("parseAndValidateQualityGate", () => {
  it("accepts a valid ready object with evidence", () => {
    const result = parseAndValidateQualityGate(READY_RUFF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.status).toBe("ready");
      expect(result.file.checks[0]!.evidence).toContain("pyproject.toml [tool.ruff]");
    }
  });

  it("accepts output wrapped in a ```json fence", () => {
    const result = parseAndValidateQualityGate("```json\n" + READY_RUFF + "\n```");
    expect(result.ok).toBe(true);
  });

  it("rejects a ready config with no evidence-backed checks (no generic fallback)", () => {
    const bad = JSON.stringify({
      status: "ready",
      checks: [{ name: "lint", category: "lint", command: "echo lint", required: true }]
      // no evidence -> dropped -> ready with zero checks -> rejected
    });
    const result = parseAndValidateQualityGate(bad);
    expect(result.ok).toBe(false);
  });

  it("accepts an incomplete config that names its gaps", () => {
    const result = parseAndValidateQualityGate(
      JSON.stringify({ status: "incomplete", checks: [], needsResolution: ["No test runner declared."] })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an incomplete config without needsResolution", () => {
    const result = parseAndValidateQualityGate(JSON.stringify({ status: "incomplete", checks: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid status", () => {
    const result = parseAndValidateQualityGate(JSON.stringify({ status: "maybe", checks: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects non-JSON output", () => {
    const result = parseAndValidateQualityGate("I think you should run pytest");
    expect(result.ok).toBe(false);
  });
});

/** A ready config carrying a single lint check with an optional workingDirectory. */
function readyCheckWith(workingDirectory?: string): string {
  const check: Record<string, unknown> = {
    name: "lint",
    category: "lint",
    command: "ruff check .",
    required: true,
    evidence: ["pyproject.toml [tool.ruff]"]
  };
  if (workingDirectory !== undefined) check["workingDirectory"] = workingDirectory;
  return JSON.stringify({ status: "ready", checks: [check], rationale: "Ruff in pyproject.toml." });
}

describe("parseAndValidateQualityGate workingDirectory containment", () => {
  it("keeps a safe relative working directory", () => {
    const result = parseAndValidateQualityGate(readyCheckWith("packages/web"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBe("packages/web");
  });

  it("keeps an interior .. that folds back inside the repo", () => {
    // a/../b normalizes to b, which stays inside the repo root.
    const result = parseAndValidateQualityGate(readyCheckWith("a/../b"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBe("a/../b");
  });

  it("drops an absolute working directory so the check runs from the repo root", () => {
    const result = parseAndValidateQualityGate(readyCheckWith("/etc"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBeUndefined();
  });

  it("drops a working directory that escapes the repo via ..", () => {
    const result = parseAndValidateQualityGate(readyCheckWith("../sibling"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBeUndefined();
  });

  it("drops a deeper traversal that normalizes outside the repo", () => {
    // a/../../escape normalizes to ../escape, which escapes the root.
    const result = parseAndValidateQualityGate(readyCheckWith("a/../../escape"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBeUndefined();
  });
});

describe("generateProjectQualityGate lifecycle", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-root-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("returns a pending placeholder before generation runs", async () => {
    const file = await readProjectQualityGate(root, project.id);
    expect(file.status).toBe("pending");
    expect(file.checks).toEqual([]);
  });

  it("stores a ready config when the agent returns valid evidence-backed output", async () => {
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    const runner = repliesRunner(READY_RUFF);
    const file = await generateProjectQualityGate(root, project, { runner });

    expect(file.status).toBe("ready");
    expect(file.checks[0]!.command).toBe("ruff check .");
    const stored = await readProjectQualityGate(root, project.id);
    expect(stored.status).toBe("ready");
    expect(stored.generatedAt).toBeTruthy();
    expect(stored.intel).toBeTruthy();
  });

  it("falls back to deterministic synthesis from intel when the agent output is invalid", async () => {
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n[tool.pytest.ini_options]\n", "utf8");
    const runner = repliesRunner("nope, can't help");
    const file = await generateProjectQualityGate(root, project, { runner });

    // Evidence exists in the repo -> a correct per-project gate is synthesized,
    // never a generic one, even though the agent failed.
    expect(file.status).toBe("ready");
    const cmds = file.checks.map((c) => c.command);
    expect(cmds).toContain("ruff check .");
    expect(cmds).toContain("pytest");
    expect(file.rationale).toContain("deterministic");
  });

  it("stores incomplete (not a generic gate) when neither agent nor intel find evidence", async () => {
    const runner = repliesRunner("garbage");
    const file = await generateProjectQualityGate(root, project, { runner });
    expect(file.status).toBe("incomplete");
    expect(file.checks).toEqual([]);
    expect(file.needsResolution?.length).toBeGreaterThan(0);
  });
});

describe("planProjectChecks workingDirectory containment", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-cwd-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("does not set PlannedCheck.cwd for an unsafe working directory stored on disk", async () => {
    // Stored configs are re-read with only a loose shape check, so the
    // containment guard must hold at the planning boundary, not just at parse.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        {
          name: "lint",
          category: "lint",
          command: "ruff check .",
          required: true,
          evidence: ["pyproject.toml"],
          workingDirectory: "/etc"
        }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    const check = plan.checks.find((c) => c.name === "lint");
    expect(check).toBeTruthy();
    expect(check!.cwd).toBeUndefined();
  });

  it("sets PlannedCheck.cwd for a safe relative working directory", async () => {
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        {
          name: "lint",
          category: "lint",
          command: "ruff check .",
          required: true,
          evidence: ["pyproject.toml"],
          workingDirectory: "packages/web"
        }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    const check = plan.checks.find((c) => c.name === "lint");
    expect(check!.cwd).toBe("packages/web");
  });
});
