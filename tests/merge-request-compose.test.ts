import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildComposePrompt,
  buildFallbackMergeRequestContent,
  composeMergeRequestContent,
  extractHandoffSections,
  gatherComposeInputs
} from "../src/core/merge-request/compose.ts";
import type { HarnessTask } from "../src/core/types.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

function baseTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    id: "9b4de099-a5ff-40e0-9410-86cca1902b7e",
    title: "Add post-push MR stage",
    description: "## Goal\nCreate merge requests after push.\n\n## Plan\nImplement provider abstraction.",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [
      {
        id: "m1",
        author: "agent",
        body: [
          "Drafting provider abstraction.",
          "",
          "**Pushed.** harness/abc · 1 commit(s) · add merge request providers.",
          "",
          "**Verified.** npm test (12 pass).",
          "",
          "**Open.** None.",
          "",
          "**Watch.** Provider auth still stubbed in tests."
        ].join("\n"),
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    approvedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("merge request compose", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-compose-"));
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
    await exec("git", ["commit", "--allow-empty", "-m", "Initial"], { cwd: repoDir });
    await exec("git", ["commit", "--allow-empty", "-m", "Add merge request providers"], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("includes ticket, commits, and diff stat in compose prompt inputs", async () => {
    const task = baseTask({ workspacePath: repoDir });
    const context = await gatherComposeInputs({
      task,
      repoPath: repoDir,
      baseBranch: "main",
      sourceBranch: "harness/abc"
    });

    const prompt = buildComposePrompt(context);
    expect(prompt).toContain("Add post-push MR stage");
    expect(prompt).toContain("task://9b4de099-a5ff-40e0-9410-86cca1902b7e");
    expect(prompt).toContain("Add merge request providers");
    expect(prompt).toContain("## Overview");
    expect(prompt).toContain("## Key Changes");
    expect(prompt).toContain("## Impact");
    expect(prompt).toContain("conventional commit prefixes");
    expect(context.commitSubjects).toContain("Add merge request providers");
  });

  it("extracts structured handoff sections and ignores agent narration", () => {
    const handoff = extractHandoffSections(
      [
        "I'll start by loading skills and exploring the codebase.",
        "Implementing providers now.",
        "",
        "**Pushed.** harness/abc · 1 commit(s) · add merge request providers.",
        "",
        "**Verified.** npm test (12 pass).",
        "",
        "**Open.** None.",
        "",
        "**Watch.** Provider auth still stubbed in tests."
      ].join("\n")
    );

    expect(handoff.pushed).toContain("add merge request providers");
    expect(handoff.verified).toContain("npm test (12 pass)");
    expect(handoff.watch).toContain("Provider auth still stubbed");
  });

  it("uses lean fallback content from handoff instead of redundant PR boilerplate", async () => {
    const task = baseTask({ workspacePath: repoDir });
    const context = await gatherComposeInputs({
      task,
      repoPath: repoDir,
      baseBranch: "main",
      sourceBranch: "harness/abc"
    });
    const fallback = buildFallbackMergeRequestContent(context);

    expect(fallback.title).toBe("feat: Add post-push MR stage");
    expect(fallback.description).toContain("task://9b4de099-a5ff-40e0-9410-86cca1902b7e");
    expect(fallback.description).toContain("## Overview");
    expect(fallback.description).toContain("Create merge requests after push.");
    expect(fallback.description).toContain("## Key Changes");
    expect(fallback.description).toContain("add merge request providers");
    expect(fallback.description).toContain("## Impact");
    expect(fallback.description).toContain("npm test (12 pass)");
    expect(fallback.description).toContain("Provider auth still stubbed");
    expect(fallback.description).not.toContain("## Summary");
    expect(fallback.description).not.toContain("## What changed");
    expect(fallback.description).not.toContain("## Test plan");
    expect(fallback.description).not.toContain("## Notes for reviewer");
    expect(fallback.description).not.toContain("## Commits");
    expect(fallback.description).not.toContain("## Diff stat");
    expect(fallback.description).not.toContain("## Author notes");
    expect(fallback.description).not.toContain("I'll start by loading");
    expect(fallback.usedFallback).toBe(true);
  });

  it("omits generic how-to-test boilerplate when verification is missing", async () => {
    const task = baseTask({
      workspacePath: repoDir,
      messages: [{ id: "m1", author: "agent", body: "Done.", createdAt: "2026-01-01T00:00:00.000Z" }]
    });
    const context = await gatherComposeInputs({
      task,
      repoPath: repoDir,
      baseBranch: "main",
      sourceBranch: "harness/abc"
    });
    const fallback = buildFallbackMergeRequestContent(context);

    expect(fallback.description).toContain("## Overview");
    expect(fallback.description).toContain("## Key Changes");
    expect(fallback.description).not.toContain("## Test plan");
    expect(fallback.description).not.toContain("acceptance criteria");
  });

  it("honors operator overrides from step config", async () => {
    const task = baseTask({ workspacePath: repoDir });
    const composed = await composeMergeRequestContent({
      task,
      repoPath: repoDir,
      baseBranch: "main",
      sourceBranch: "harness/abc",
      overrides: {
        title: "Custom MR title",
        description: "Custom MR body"
      }
    });

    expect(composed.title).toBe("Custom MR title");
    expect(composed.description).toBe("Custom MR body");
    expect(composed.usedFallback).toBe(false);
  });

  it("parses agent JSON when a runner is provided", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      '{"title":"Agent title","description":"## Overview\\n\\nAgent overview.\\n\\n## Key Changes\\n\\n- Agent change.\\n\\n## Impact\\n\\nAgent body with testing notes."}'
    ]);

    const task = baseTask({ workspacePath: repoDir });
    const composed = await composeMergeRequestContent(
      {
        task,
        repoPath: repoDir,
        baseBranch: "main",
        sourceBranch: "harness/abc"
      },
      { runner }
    );

    expect(composed.title).toBe("Agent title");
    expect(composed.description).toContain("## Overview");
    expect(composed.description).toContain("testing notes");
    expect(composed.usedFallback).toBe(false);
  });

  it("falls back to structured markdown when agent JSON has an unstructured description", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      JSON.stringify({
        title: "Agent title",
        description:
          "Verified with npm run check green. Residual risks: reviewer should confirm frontend-ui-change still covers the right workflows."
      })
    ]);

    const task = baseTask({ workspacePath: repoDir });
    const composed = await composeMergeRequestContent(
      {
        task,
        repoPath: repoDir,
        baseBranch: "main",
        sourceBranch: "harness/abc"
      },
      { runner }
    );

    expect(composed.title).toBe("Agent title");
    expect(composed.description).toContain("## Overview");
    expect(composed.description).toContain("## Key Changes");
    expect(composed.description).toContain("## Impact");
    expect(composed.description).toContain("task://9b4de099-a5ff-40e0-9410-86cca1902b7e");
    expect(composed.description).not.toContain("Residual risks: reviewer should confirm");
    expect(composed.usedFallback).toBe(true);
  });
});

function uiTask(repoDir: string, workflowId: string): HarnessTask {
  return baseTask({
    workspacePath: repoDir,
    workflowRun: {
      workflowId,
      currentStepId: "create_merge_request",
      completedSteps: ["implement_ui", "checks"],
      stepApprovals: {}
    }
  });
}

async function repoWithScreenshot(options: {
  remote: string;
  screenshotPath: string;
}): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-compose-ui-"));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("git", ["init"], { cwd: repoDir });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
  await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
  await exec("git", ["commit", "--allow-empty", "-m", "Initial"], { cwd: repoDir });
  await exec("git", ["remote", "add", "origin", options.remote], { cwd: repoDir });
  await exec("git", ["checkout", "-b", "harness/ui"], { cwd: repoDir });
  const fullPath = path.join(repoDir, options.screenshotPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, "png-bytes");
  await exec("git", ["add", "-A"], { cwd: repoDir });
  await exec("git", ["commit", "-m", "UI change with screenshot"], { cwd: repoDir });
  return repoDir;
}

describe("merge request compose visual review", () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("embeds committed screenshots for a UI workflow with a resolved remote", async () => {
    const repoDir = await repoWithScreenshot({
      remote: "https://github.com/octocat/hello-world.git",
      screenshotPath: "screenshots/before.png"
    });
    dirs.push(repoDir);

    const composed = await composeMergeRequestContent({
      task: uiTask(repoDir, "frontend-ui-change"),
      repoPath: repoDir,
      baseBranch: "main",
      sourceBranch: "harness/ui"
    });

    expect(composed.description).toContain("## Visual Review");
    expect(composed.description).toContain(
      "![UI change: screenshots/before.png](https://github.com/octocat/hello-world/raw/harness/ui/screenshots/before.png)"
    );
    // The mandated sections are still present and precede the visual review.
    expect(composed.description).toContain("## Overview");
    expect(composed.description).toContain("## Key Changes");
    expect(composed.description.indexOf("## Impact")).toBeLessThan(
      composed.description.indexOf("## Visual Review")
    );
  });

  it("embeds screenshots on the gitlab raw host", async () => {
    const repoDir = await repoWithScreenshot({
      remote: "https://gitlab.com/group/project.git",
      screenshotPath: "screenshots/after.png"
    });
    dirs.push(repoDir);

    const composed = await composeMergeRequestContent({
      task: uiTask(repoDir, "frontend-ui-change"),
      repoPath: repoDir,
      baseBranch: "main",
      sourceBranch: "harness/ui"
    });

    expect(composed.description).toContain("## Visual Review");
    expect(composed.description).toContain(
      "![UI change: screenshots/after.png](https://gitlab.com/group/project/-/raw/harness/ui/screenshots/after.png)"
    );
  });

  it("leaves non-UI workflows unaffected even when a screenshot is committed", async () => {
    const repoDir = await repoWithScreenshot({
      remote: "https://github.com/octocat/hello-world.git",
      screenshotPath: "screenshots/before.png"
    });
    dirs.push(repoDir);

    const composed = await composeMergeRequestContent({
      task: uiTask(repoDir, "code-feature"),
      repoPath: repoDir,
      baseBranch: "main",
      sourceBranch: "harness/ui"
    });

    expect(composed.description).not.toContain("## Visual Review");
    expect(composed.description).not.toContain("raw/harness/ui");
  });

  it("omits the visual review for a UI workflow without a committed screenshot", async () => {
    const repoDir = await repoWithScreenshot({
      remote: "https://github.com/octocat/hello-world.git",
      screenshotPath: "assets/hero.png" // committed but outside a screenshots/ path
    });
    dirs.push(repoDir);

    const composed = await composeMergeRequestContent({
      task: uiTask(repoDir, "frontend-ui-change"),
      repoPath: repoDir,
      baseBranch: "main",
      sourceBranch: "harness/ui"
    });

    expect(composed.description).not.toContain("## Visual Review");
  });

  it("appends the visual review to an agent-generated description", async () => {
    const repoDir = await repoWithScreenshot({
      remote: "https://github.com/octocat/hello-world.git",
      screenshotPath: "screenshots/before.png"
    });
    dirs.push(repoDir);

    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      '{"title":"Agent title","description":"## Overview\\n\\nAgent overview.\\n\\n## Key Changes\\n\\n- UI\\n\\n## Impact\\n\\nPolish."}'
    ]);

    const composed = await composeMergeRequestContent(
      {
        task: uiTask(repoDir, "frontend-ui-change"),
        repoPath: repoDir,
        baseBranch: "main",
        sourceBranch: "harness/ui"
      },
      { runner }
    );

    expect(composed.title).toBe("Agent title");
    expect(composed.description).toContain("Agent overview.");
    expect(composed.description).toContain("## Visual Review");
    expect(composed.description).toContain("raw/harness/ui/screenshots/before.png");
  });
});
