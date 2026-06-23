import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";
import { createRun } from "../src/core/tasks/runs.ts";
import { createTask } from "../src/core/tasks/tasks.ts";
import { createServer } from "../src/server/app.ts";
import { buildMemoryIndex, searchMemoryIndex, summarizeMemoryIndex } from "../src/memory/index.ts";
import { captureMemoryPage } from "../src/memory/store.ts";

async function onboard(root: string, name: string): Promise<string> {
  execSync(`git init ${name}`, { cwd: root });
  const project = await onboardProject(root, { repoPath: path.join(root, name), name });
  return project.id;
}

describe("embedded memory index", () => {
  let root: string;
  let homeRoot: string;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-memory-index-"));
    homeRoot = await mkdtemp(path.join(tmpdir(), "harness-home-"));
    execSync("git init", { cwd: root });
    await ensureHarnessRepository(root);
    projectId = await onboard(root, "alpha");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
  });

  it("rebuilds a project-scoped index from memory, work artifacts, and explicit target files", async () => {
    await captureMemoryPage(root, projectId, {
      slug: "decisions/memory-index",
      type: "decision",
      title: "Memory Index",
      tags: ["search"],
      content: "Use a generated local index for latent recall covenant before adding embeddings."
    });
    await createTask(root, {
      title: "Add semantic recall",
      description: "Index harness artifacts for future agents.",
      agent: "codex",
      source: "manual",
      links: [],
      projectId
    });
    const run = await createRun(root, {
      taskId: "task-1",
      taskTitle: "Fake run",
      projectId,
      agent: "codex",
      status: "completed",
      startedAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-27T00:01:00.000Z",
      artifacts: ["summary.md"]
    });
    await mkdir(path.join(root, "data", "runs", run.id), { recursive: true });
    await writeFile(path.join(root, "data", "runs", run.id, "summary.md"), "Run artifact mentions vector search.", "utf8");
    const targetFile = path.join(homeRoot, "notes", "agent-search.md");
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(targetFile, "Target file discusses embeddings and memory retrieval.", "utf8");

    const index = await buildMemoryIndex(root, projectId, { homeRoot, targetPaths: [targetFile] });

    expect(index.documents.map((document) => document.sourceType)).toEqual(
      expect.arrayContaining(["memory", "task", "run-artifact", "file"])
    );
    await expect(
      readFile(path.join(projectDir(root, projectId), "memory-index", "documents.json"), "utf8")
    ).resolves.toContain("Target file discusses embeddings");
    expect((await searchMemoryIndex(root, projectId, "latent recall covenant")).at(0)).toMatchObject({
      sourceType: "memory",
      title: "Memory Index"
    });
  });

  it("skips missing run artifacts while indexing existing run data", async () => {
    const run = await createRun(root, {
      taskId: "task-1",
      taskTitle: "Interrupted run",
      projectId,
      agent: "codex",
      status: "running",
      startedAt: "2026-05-27T00:00:00.000Z",
      artifacts: ["summary.md", "log.txt"]
    });
    await mkdir(path.join(root, "data", "runs", run.id), { recursive: true });
    await writeFile(path.join(root, "data", "runs", run.id, "log.txt"), "Partial log is still useful.", "utf8");

    const index = await buildMemoryIndex(root, projectId);

    expect(index.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `run:${run.id}`, sourceType: "run" }),
        expect.objectContaining({ id: `run-artifact:${run.id}:log.txt`, sourceType: "run-artifact" })
      ])
    );
    expect(index.documents.some((document) => document.id === `run-artifact:${run.id}:summary.md`)).toBe(false);
  });

  it("searches the generated index and exposes rebuild/search through the API", async () => {
    const targetFile = path.join(homeRoot, "repo", "README.md");
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(targetFile, "This repository uses a durable local memory index.", "utf8");
    const app = createServer({ root, homeRoot });

    const rebuild = await request(app)
      .post("/api/memory/index/rebuild")
      .send({ projectId, targetPaths: [targetFile] })
      .expect(200);
    expect(rebuild.body.documents[0].sourceType).toBe("file");

    expect((await searchMemoryIndex(root, projectId, "durable local")).at(0)?.path).toBe(targetFile);
    const search = await request(app)
      .get("/api/memory/index/search")
      .query({ projectId, q: "memory index" })
      .expect(200);
    expect(search.body[0].path).toBe(targetFile);
  });

  it("removes a deleted memory page from the index so it no longer matches searches", async () => {
    const app = createServer({ root });
    await captureMemoryPage(root, projectId, {
      slug: "decisions/stale-search",
      type: "decision",
      title: "Stale Search",
      tags: ["recall"],
      content: "Unique recall token qyzxjkw for the deleted page."
    });
    await buildMemoryIndex(root, projectId);

    const beforeDelete = await searchMemoryIndex(root, projectId, "qyzxjkw");
    expect(beforeDelete.some((document) => document.sourceType === "memory")).toBe(true);

    await request(app).delete(`/api/memory/pages/decisions/stale-search?projectId=${projectId}`).expect(204);

    const afterDelete = await searchMemoryIndex(root, projectId, "qyzxjkw");
    expect(afterDelete.filter((document) => document.sourceType === "memory")).toEqual([]);
  });

  it("summarizes indexed document counts by source type", async () => {
    await captureMemoryPage(root, projectId, {
      slug: "notes/example",
      type: "note",
      title: "Example",
      tags: [],
      content: "Example memory page."
    });
    await createTask(root, {
      title: "Indexed task",
      description: "Task body.",
      agent: "codex",
      source: "manual",
      links: [],
      projectId
    });

    const index = await buildMemoryIndex(root, projectId);

    expect(summarizeMemoryIndex(index)).toBe("1 wiki page, 1 task (2 searchable documents)");
  });
});
