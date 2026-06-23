import { execSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { processNextApprovedTask } from "../src/daemon/processor.ts";
import {
  buildMemoryRecallQuery,
  buildMemoryRecallSection,
  formatMemoryRecallSection,
  recallMemoryForTask
} from "../src/memory/recall.ts";
import { captureMemoryPage } from "../src/memory/store.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject } from "../src/core/projects/registry.ts";
import { approveTask, createTask } from "../src/core/tasks/tasks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import type { HarnessTask } from "../src/core/types.ts";

async function onboard(root: string, name: string): Promise<string> {
  execSync(`git init ${name}`, { cwd: root });
  const project = await onboardProject(root, { repoPath: path.join(root, name), name });
  return project.id;
}

describe("memory recall", () => {
  let root: string;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-memory-recall-"));
    execSync("git init", { cwd: root });
    await ensureHarnessRepository(root);
    projectId = await onboard(root, "gateway");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("builds a recall query from task title, description, targets, and operator notes", () => {
    const task = {
      title: "Fix auth middleware",
      description: "Refresh session handling in the API gateway.",
      targets: [{ raw: "/Users/me/apps/gateway", path: "/Users/me/apps/gateway", kind: "directory" }],
      messages: [{ author: "operator", body: "Prefer short-lived JWTs.", createdAt: "2026-06-06T00:00:00.000Z", id: "m1" }]
    } as HarnessTask;

    expect(buildMemoryRecallQuery(task)).toContain("Fix auth middleware");
    expect(buildMemoryRecallQuery(task)).toContain("gateway");
    expect(buildMemoryRecallQuery(task)).toContain("short-lived JWTs");
  });

  it("returns ranked wiki pages for a task scoped to its project", async () => {
    await captureMemoryPage(root, projectId, {
      slug: "overview",
      type: "project",
      title: "API Gateway",
      tags: ["auth"],
      content: "Gateway uses short-lived JWTs and refresh cookies."
    });
    await captureMemoryPage(root, projectId, {
      slug: "preferences/testing",
      type: "preference",
      title: "Testing Preferences",
      tags: ["testing"],
      content: "Prefer Makefile targets."
    });

    const task = await createTask(root, {
      title: "Gateway auth refresh",
      description: "Update JWT handling in the API gateway service.",
      source: "manual",
      links: [],
      projectId,
      targets: [{ raw: "projects/gateway", path: "projects/gateway", kind: "directory" }]
    });

    const hits = await recallMemoryForTask(root, task);
    expect(hits[0]?.slug).toBe("overview");
    expect(hits.some((hit) => hit.slug === "preferences/testing")).toBe(false);
  });

  it("does not recall memory from another project", async () => {
    const other = await onboard(root, "dashboard");
    await captureMemoryPage(root, other, {
      slug: "overview",
      type: "project",
      title: "Dashboard",
      tags: ["auth"],
      content: "Dashboard uses opaque refresh token rotation with browser cookies."
    });
    await captureMemoryPage(root, projectId, {
      slug: "overview",
      type: "project",
      title: "Gateway",
      tags: ["auth"],
      content: "Gateway uses opaque refresh token rotation."
    });

    const task = await createTask(root, {
      title: "Refresh token rotation",
      description: "Update opaque token behavior.",
      source: "manual",
      links: [],
      projectId,
      targets: [{ raw: "/Users/me/apps/gateway", path: "/Users/me/apps/gateway", kind: "directory" }]
    });

    const hits = await recallMemoryForTask(root, task);
    expect(hits.map((hit) => hit.title)).toContain("Gateway");
    expect(hits.map((hit) => hit.title)).not.toContain("Dashboard");
  });

  it("returns no recall for a task with no project", async () => {
    await captureMemoryPage(root, projectId, {
      slug: "overview",
      type: "project",
      title: "Gateway",
      tags: ["auth"],
      content: "Gateway uses opaque refresh token rotation."
    });
    const task = await createTask(root, {
      title: "Token rotation",
      description: "Opaque token rotation in the gateway.",
      source: "manual",
      links: []
    });
    expect(await recallMemoryForTask(root, task)).toEqual([]);
  });

  it("formats recalled pages for prompt injection", () => {
    const section = formatMemoryRecallSection([
      {
        projectId: "proj-x",
        slug: "preferences/testing",
        type: "preference",
        title: "Testing Preferences",
        tags: ["testing"],
        updatedAt: "2026-06-06T00:00:00.000Z",
        score: 2,
        snippet: "Prefer Makefile targets and focused unit tests."
      }
    ]);

    expect(section).toContain("## Recalled memory (harness wiki)");
    expect(section).toContain("preferences/testing");
    expect(section).toContain("Makefile targets");
    expect(section).toContain("gbrain_read");
  });

  it("injects recalled wiki pages into daemon turn prompts", async () => {
    await captureMemoryPage(root, projectId, {
      slug: "overview",
      type: "project",
      title: "Harness",
      tags: ["agents"],
      content: "Harness memory is a durable wiki under the project state dir."
    });

    const task = await createTask(root, {
      title: "Harness memory recall",
      description: "Ensure wiki pages surface on task turns.",
      workflowId: "bugfix",
      source: "manual",
      links: [],
      projectId,
      targets: [{ raw: "projects/gateway", path: "projects/gateway", kind: "directory" }]
    });
    await approveTask(root, task.id);

    const result = await processNextApprovedTask(root, {
      runner: new DeterministicAgentRunner("codex"),
      wait: true
    });

    const prompt = await readFile(path.join(root, "data", "runs", result!.runId, "prompt.md"), "utf8");
    expect(prompt).toContain("## Recalled memory (harness wiki)");
    expect(prompt).toContain("durable wiki");
  });

  it("returns an empty section when no wiki pages match", async () => {
    const task = await createTask(root, {
      title: "Unrelated task",
      description: "Nothing in memory should match this.",
      source: "manual",
      links: [],
      projectId
    });

    await expect(buildMemoryRecallSection(root, task)).resolves.toBe("");
  });
});
