import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { onboardProject, type ProjectRecord } from "../src/core/projects/registry.ts";
import type { ProjectIntel } from "../src/core/projects/intel.ts";
import type { QualityGateFile } from "../src/core/projects/quality-gate.ts";
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

/** Poll until the gate leaves a non-terminal in-flight state or hits the expected status. */
async function waitForQualityGate(
  root: string,
  projectId: string,
  expected: QualityGateFile["status"],
  timeoutMs = 15_000
): Promise<QualityGateFile> {
  const { readProjectQualityGate } = await import("../src/core/projects/quality-gate.ts");
  const deadline = Date.now() + timeoutMs;
  let latest = await readProjectQualityGate(root, projectId);
  while (Date.now() < deadline) {
    latest = await readProjectQualityGate(root, projectId);
    if (latest.status === expected) return latest;
    if (latest.status !== "generating") return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest;
}

describe("quality-gate generation recovery", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-rec-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    project = await onboardProject(root, { repoPath: repo, name: "Rec" });
  });

  afterEach(async () => {
    vi.doUnmock("../src/core/projects/quality-gate.ts");
    vi.doUnmock("../src/core/projects/intel.ts");
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("writes a terminal failed state when generation rejects (not stuck at generating)", async () => {
    // The fire-and-forget generation only rejects when its terminal persist
    // (stampAndStore) throws. Simulate one transient terminal-write failure: the
    // `generating` heartbeat writes succeed, the first terminal stamp throws, then
    // the recovery write of `failed` succeeds. The launch must surface `failed`
    // instead of swallowing the error and leaving the gate at `generating` forever.
    vi.resetModules();
    vi.doMock("../src/core/projects/quality-gate.ts", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/core/projects/quality-gate.ts")>();
      let threw = false;
      return {
        ...actual,
        writeQualityGate: (r: string, id: string, file: QualityGateFile) => {
          if (file.status !== "generating" && !threw) {
            threw = true;
            throw new Error("simulated terminal write failure");
          }
          return actual.writeQualityGate(r, id, file);
        }
      };
    });

    const { startProjectQualityGate } = await import("../src/core/projects/quality-gate-generation.ts");

    await startProjectQualityGate(root, project, { runner: repliesRunner("nope"), agent: "claude" });
    const stored = await waitForQualityGate(root, project.id, "failed");
    expect(stored.status).toBe("failed");
    expect(stored.error ?? "").toMatch(/simulated terminal write failure/);
  });

  it("re-kicks a gate left generating by a prior process (stale, not in-flight)", async () => {
    const { writeQualityGate } = await import("../src/core/projects/quality-gate.ts");
    const { reconcileStaleQualityGates } = await import(
      "../src/core/projects/quality-gate-generation.ts"
    );

    // Simulate a crashed prior process: the gate is persisted as `generating` but
    // nothing in this process is driving it (the in-flight guard is empty).
    await writeQualityGate(root, project.id, { status: "generating", checks: [] });

    const reKicked = await reconcileStaleQualityGates(root, {
      runner: repliesRunner(READY_RUFF),
      agent: "claude"
    });
    expect(reKicked).toBe(1);

    const stored = await waitForQualityGate(root, project.id, "ready");
    expect(stored.status).toBe("ready");
  });

  it("does not double-kick a gate that is genuinely generating in this process", async () => {
    // A generation actually in flight (its key is in the in-memory guard) must not be
    // re-kicked: doing so would race two agent turns for one project. Stall intel
    // gathering so the launch stays in its `generating` window, then sweep.
    let resolveGather!: (intel: ProjectIntel) => void;
    const gatherGate = new Promise<ProjectIntel>((resolve) => {
      resolveGather = resolve;
    });
    vi.resetModules();
    vi.doMock("../src/core/projects/intel.ts", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/core/projects/intel.ts")>();
      return { ...actual, gatherProjectIntel: () => gatherGate };
    });

    const { startProjectQualityGate, reconcileStaleQualityGates } = await import(
      "../src/core/projects/quality-gate-generation.ts"
    );
    const { readProjectQualityGate } = await import("../src/core/projects/quality-gate.ts");

    await startProjectQualityGate(root, project, { runner: repliesRunner("nope"), agent: "claude" });

    const reKicked = await reconcileStaleQualityGates(root);
    expect(reKicked).toBe(0);
    expect((await readProjectQualityGate(root, project.id)).status).toBe("generating");

    // Release the stalled gather so generation completes and frees the in-flight guard.
    resolveGather({ repoPath: repo, markers: [], commands: [], docs: [], ci: [], buildConfigs: [], summary: [] });
    const stored = await waitForQualityGate(root, project.id, "failed");
    expect(stored.status).toBe("failed");
  });
});
