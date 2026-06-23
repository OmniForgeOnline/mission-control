import { execSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  captureFromOperatorMessage,
  captureLessonFromReply,
  captureProjectContextFromTask,
  captureTaskCompletion,
  shouldAutoCaptureTask
} from "../src/memory/auto-capture.ts";
import { PROPOSAL_SECTION_MARKER } from "../src/core/proposals/ticket.ts";
import { captureMemoryPage, listMemoryPages } from "../src/memory/store.ts";
import { addTaskMessage, createTask } from "../src/core/tasks/tasks.ts";
import { createRun } from "../src/core/tasks/runs.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";
import type { HarnessTask } from "../src/core/types.ts";

describe("auto memory capture", () => {
  let root: string;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-auto-capture-"));
    execSync("git init", { cwd: root });
    await ensureHarnessRepository(root);
    execSync("git init gateway", { cwd: root });
    projectId = (await onboardProject(root, { repoPath: path.join(root, "gateway"), name: "gateway" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function overviewPath(): string {
    return path.join(projectDir(root, projectId), "memory", "pages", "overview.md");
  }

  it("captures explicit agent lessons directly into the wiki", async () => {
    const run = await createRun(root, {
      taskId: "task-1",
      taskTitle: "Test task",
      projectId,
      agent: "claude",
      status: "completed",
      startedAt: new Date().toISOString(),
      artifacts: []
    });

    await captureLessonFromReply(
      root,
      fakeTask(),
      { ...run, status: "completed", artifacts: [] },
      "I learned that this project always prefers vitest over jest for testing. This is important to remember when adding new test files."
    );

    const pages = await listMemoryPages(root, projectId);
    const lessonFiles = pages.filter((page) => page.slug.startsWith("lessons/"));
    expect(lessonFiles.length).toBeGreaterThan(0);
    expect(lessonFiles[0]?.title.toLowerCase()).toContain("vitest");
  });

  it("does not capture lessons for a task with no project", async () => {
    const run = await createRun(root, {
      taskId: "task-np",
      taskTitle: "No project",
      agent: "claude",
      status: "completed",
      startedAt: new Date().toISOString(),
      artifacts: []
    });
    const noProjectTask = {
      id: "test-task-1",
      title: "Test task",
      description: "A test task",
      agent: "claude",
      source: "manual",
      links: [],
      targets: [],
      messages: [],
      resolution: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as HarnessTask;
    const page = await captureLessonFromReply(
      root,
      noProjectTask,
      { ...run, status: "completed", artifacts: [] },
      "I learned that this project always prefers vitest over jest for testing."
    );
    expect(page).toBeNull();
  });

  it("does not duplicate lessons already present in memory", async () => {
    await captureMemoryPage(root, projectId, {
      slug: "lessons/vitest-preference",
      type: "lesson",
      title: "Vitest preference",
      tags: ["testing"],
      content: "This project always prefers vitest over jest for testing. Important to remember when adding new test files."
    });

    const page = await captureLessonFromReply(
      root,
      fakeTask(),
      await fakeRun(root),
      "I learned that this project always prefers vitest over jest for testing."
    );

    expect(page).toBeNull();
    expect(await listMemoryPages(root, projectId)).toHaveLength(1);
  });

  it("captures operator corrections and preferences", async () => {
    const page = await captureFromOperatorMessage(
      root,
      fakeTask({ id: "task-op-1", title: "Gateway auth refresh" }),
      "Going forward, always prefer short-lived JWTs with refresh cookies instead of long-lived bearer tokens."
    );

    expect(page?.slug).toBe("corrections/gateway-auth-refresh");
    expect(page?.type).toBe("correction");
  });

  it("creates a project overview page when a task is created in a project", async () => {
    const task = await createTask(root, {
      title: "Add health endpoint",
      description: "Expose /health on the gateway service.",
      source: "manual",
      links: [],
      projectId,
      targets: [{ raw: "/Users/me/gateway", path: "/Users/me/gateway", kind: "directory" }]
    });

    let found = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const pages = await listMemoryPages(root, projectId);
      found = pages.some((page) => page.slug === "overview");
      if (found) break;
      await captureProjectContextFromTask(root, task);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(found).toBe(true);
  });

  it("appends completion summaries to the project overview page", async () => {
    const task = await createTask(root, {
      title: "Gateway auth refresh",
      description: "Update JWT handling.",
      source: "manual",
      links: [],
      projectId,
      targets: [{ raw: "/Users/me/gateway", path: "/Users/me/gateway", kind: "directory" }]
    });
    await captureProjectContextFromTask(root, task);

    const summary =
      "Implemented refresh-cookie rotation and updated middleware tests. All checks passed and the branch is ready for review with no manual operator steps required beyond merge.";

    await captureTaskCompletion(root, task, summary);

    const file = await readFile(overviewPath(), "utf8");
    expect(file).toContain("Completed: Gateway auth refresh");
    expect(file).toContain("refresh-cookie rotation");
  });

  it("skips auto-capture for synthetic and proposal tasks", () => {
    const qualityGate = fakeTask({ title: "Quality gate: mcp" });
    expect(shouldAutoCaptureTask(qualityGate)).toBe(false);

    const proposal = fakeTask({
      title: "Skill: operator-handoff",
      description: `${PROPOSAL_SECTION_MARKER}\n\n- **Kind:** skill`
    });
    expect(shouldAutoCaptureTask(proposal)).toBe(false);
  });

  it("does not create project pages for quality-gate tasks", async () => {
    const task = fakeTask({ title: "Quality gate: mcp", description: "Bring mcp domain to grade A." });

    await expect(captureProjectContextFromTask(root, task)).resolves.toBeNull();
    expect(await listMemoryPages(root, projectId)).toHaveLength(0);
  });

  it("does not capture reviewer verdicts as completion memory", async () => {
    const task = await createTask(root, {
      title: "Gateway auth refresh",
      description: "Update JWT handling.",
      source: "manual",
      links: [],
      projectId,
      targets: [{ raw: "/Users/me/gateway", path: "/Users/me/gateway", kind: "directory" }]
    });
    await captureProjectContextFromTask(root, task);

    const reviewReply = `Reviewing the pushed branch.\n\`\`\`json\n{"decision": "approve", "summary": "Looks good."}\n\`\`\``;

    await expect(captureTaskCompletion(root, task, reviewReply)).resolves.toBeNull();
    const file = await readFile(overviewPath(), "utf8");
    expect(file).not.toContain("approve");
  });

  it("does not capture outcomes for a task with no project", async () => {
    const noProjectTask = {
      id: "test-task-1",
      title: "Fix path tagging",
      description: "Autocomplete fix.",
      agent: "claude",
      source: "manual",
      links: [],
      targets: [],
      messages: [],
      resolution: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as HarnessTask;
    const summary =
      "Implemented server-side completion merging historical paths. All tests pass and the branch is ready for review.";
    await expect(captureTaskCompletion(root, noProjectTask, summary)).resolves.toBeNull();
  });

  it("captures operator messages added through addTaskMessage", async () => {
    const task = await createTask(root, {
      title: "Docs cleanup",
      description: "Refresh README.",
      source: "manual",
      links: [],
      projectId
    });

    await addTaskMessage(root, task.id, {
      author: "operator",
      body: "Remember: always keep harness docs in complete sentences, never telegraphic bullet chains."
    });

    const expectedSlug = "corrections/docs-cleanup";
    let pages = await listMemoryPages(root, projectId);
    const deadline = Date.now() + 2000;
    while (!pages.some((page) => page.slug === expectedSlug) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      pages = await listMemoryPages(root, projectId);
    }
    expect(pages.some((page) => page.slug === expectedSlug)).toBe(true);
  });

  function fakeTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
    return {
      id: "test-task-1",
      title: "Test task",
      description: "A test task",
      agent: "claude",
      source: "manual",
      links: [],
      targets: [],
      messages: [],
      projectId,
      resolution: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides
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
});
