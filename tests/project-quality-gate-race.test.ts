import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { onboardProject, type ProjectRecord } from "../src/core/projects/registry.ts";
import { readProjectQualityGate } from "../src/core/projects/quality-gate.ts";
import type { ProjectIntel } from "../src/core/projects/intel.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

function repliesRunner(reply: string): DeterministicAgentRunner {
  const runner = new DeterministicAgentRunner("claude");
  runner.setReplies([reply]);
  return runner;
}

/** Yield long enough for a fire-and-forget generation to land its first fs write. */
async function settleFirstWrite(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("quality-gate generation race (onboarding fire-and-forget)", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;
  let resolveGather: (intel: ProjectIntel) => void;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-race-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    // A real marker keeps intel non-empty, but the assertion is about gate state
    // during the in-flight window, not the curated result.
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    project = await onboardProject(root, { repoPath: repo, name: "Race" });

    // Stall intel gathering in a controllable way. The generation module imports
    // gatherProjectIntel from ./intel.ts, so mocking that module makes the stall
    // take effect regardless of the implementation under test: the gate must read
    // `generating` for the whole window intel gathering occupies, never `pending`
    // (which would let the generic package/Makefile baseline run on a project
    // whose own gate generation has already started).
    const gatherGate = new Promise<ProjectIntel>((resolve) => {
      resolveGather = resolve;
    });
    vi.doMock("../src/core/projects/intel.ts", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/core/projects/intel.ts")>();
      return { ...actual, gatherProjectIntel: () => gatherGate };
    });
  });

  afterEach(async () => {
    vi.doUnmock("../src/core/projects/intel.ts");
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("durably writes generating before returning, so the gate is never pending mid-flight", async () => {
    // Imported AFTER the doMock above so the generation module picks up the stalled intel.
    const { startProjectQualityGate } = await import("../src/core/projects/quality-gate-generation.ts");

    // The launch MUST await its first `generating` write before returning. The real
    // onboarding path (POST /projects) reads the gate the moment onboarding responds,
    // with no settling in between; if the launch returned while the write was still in
    // flight, that immediate read would see `pending` (the generic-baseline interim).
    // So: await the launch, then read with no yielding in between; it must be
    // `generating`, proving the onboarding race is closed.
    await startProjectQualityGate(root, project, { runner: repliesRunner("nope"), agent: "claude" });
    const stored = await readProjectQualityGate(root, project.id);
    expect(stored.status).toBe("generating");

    // Release the stalled gather so generation runs to completion and leaves no
    // dangling in-flight promise behind for the test runner.
    resolveGather({ repoPath: repo, markers: [], commands: [], docs: [], ci: [], summary: [] });
    await settleFirstWrite();
  });
});
