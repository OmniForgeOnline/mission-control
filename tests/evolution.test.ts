import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureLessonFromReply } from "../src/memory/auto-capture.ts";
import { captureMemoryPage, listMemoryPages } from "../src/memory/store.ts";
import { listProposals } from "../src/core/proposals/proposals.ts";
import { createRun } from "../src/core/tasks/runs.ts";
import { approveTask, createTask } from "../src/core/tasks/tasks.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject } from "../src/core/projects/registry.ts";
import { processNextApprovedTask } from "../src/daemon/processor.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";

async function onboard(root: string): Promise<string> {
  execSync("git init", { cwd: root });
  execSync("git init app", { cwd: root });
  return (await onboardProject(root, { repoPath: path.join(root, "app"), name: "app" })).id;
}

describe("captureLessonFromReply", () => {
  let root: string;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-evo-"));
    await ensureHarnessRepository(root);
    projectId = await onboard(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fakeTask() {
    return {
      id: "test-task-1",
      title: "Test task",
      description: "A test task",
      agent: "claude" as const,
      source: "manual" as const,
      links: [],
      targets: [],
      messages: [],
      projectId,
      status: "completed" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async function fakeRun(r: string) {
    return createRun(r, {
      taskId: "test-task-1",
      taskTitle: "Test task",
      projectId,
      agent: "claude",
      status: "completed",
      startedAt: new Date().toISOString(),
      artifacts: []
    });
  }

  it("does not create memory for a generic reply", async () => {
    await captureLessonFromReply(root, fakeTask(), await fakeRun(root), "All done, nothing special here.");

    expect(await listMemoryPages(root, projectId)).toHaveLength(0);
    expect(await listProposals(root)).toHaveLength(0);
  });

  it("captures a lesson page when the reply contains a learning pattern", async () => {
    const run = await fakeRun(root);

    await captureLessonFromReply(
      root,
      fakeTask(),
      { ...run, status: "completed", artifacts: [] },
      "I learned that this project always prefers vitest over jest for testing. This is important to remember when adding new test files."
    );

    const pages = await listMemoryPages(root, projectId);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.slug.startsWith("lessons/")).toBe(true);
    expect(pages[0]?.type).toBe("lesson");
  });

  it("does not duplicate lessons already in memory", async () => {
    await captureMemoryPage(root, projectId, {
      slug: "lessons/vitest-preference",
      type: "lesson",
      title: "Vitest preference",
      tags: ["testing"],
      content:
        "This project always prefers vitest over jest for testing. Important to remember when adding new test files."
    });

    await captureLessonFromReply(
      root,
      fakeTask(),
      await fakeRun(root),
      "I learned that this project always prefers vitest over jest for testing."
    );

    expect(await listMemoryPages(root, projectId)).toHaveLength(1);
    expect(await listProposals(root)).toHaveLength(0);
  });

  it("auto-initializes a fresh harness root when capturing a lesson", async () => {
    const freshRoot = path.join(tmpdir(), `harness-evo-fresh-${Date.now()}`);
    const page = await captureLessonFromReply(
      freshRoot,
      fakeTask(),
      await fakeRun(root),
      "I learned that this project always prefers vitest over jest for testing."
    );

    expect(page?.type).toBe("lesson");
    await rm(freshRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
});

describe("evolution during task execution", () => {
  let root: string;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-evo-task-"));
    await ensureHarnessRepository(root);
    projectId = await onboard(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not create memory from the deterministic runner's generic reply", async () => {
    const task = await createTask(root, {
      title: "Generic task",
      description: "Nothing special.",
      agent: "codex",
      source: "manual",
      links: [],
      projectId
    });
    await approveTask(root, task.id);

    await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });
    await new Promise((r) => setTimeout(r, 200));

    // Task creation seeds an `overview` page; the generic reply must add no lesson.
    const pages = await listMemoryPages(root, projectId);
    expect(pages.some((page) => page.type === "lesson")).toBe(false);
  });

  it("captures a lesson page when the agent reply contains a learning pattern", async () => {
    const task = await createTask(root, {
      title: "Discovery task",
      description: "Explore the codebase.",
      workflowId: "bugfix",
      source: "manual",
      links: [],
      projectId
    });
    await approveTask(root, task.id);

    const runner: AgentRunner = {
      agent: "claude",
      abort() {},
      async runTurn(_request: AgentTurnRequest): Promise<AgentTurnResult> {
        return {
          reply:
            "I learned that this repo always requires strict TypeScript checks. Going forward, all new files must pass tsc --noEmit.",
          sessionId: "sess-evo",
          exitCode: 0,
          command: "claude -p ...",
          rawLog: ""
        };
      }
    };

    await processNextApprovedTask(root, { runner, wait: true });
    await new Promise((r) => setTimeout(r, 200));

    const pages = await listMemoryPages(root, projectId);
    expect(pages.some((page) => page.type === "lesson")).toBe(true);
  });
});
