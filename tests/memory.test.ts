import { execSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { createServer } from "../src/server/app.ts";
import {
  captureMemoryPage,
  deleteMemoryPage,
  getMemoryPage,
  listAllMemoryPages,
  listMemoryPages,
  searchMemoryPages
} from "../src/memory/store.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";

async function onboard(root: string, name: string): Promise<string> {
  execSync(`git init ${name}`, { cwd: root });
  const project = await onboardProject(root, { repoPath: path.join(root, name), name });
  return project.id;
}

describe("per-project harness memory", () => {
  let root: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-memory-"));
    execSync("git init", { cwd: root });
    await ensureHarnessRepository(root);
    projectA = await onboard(root, "alpha");
    projectB = await onboard(root, "beta");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("captures memory pages under the project's state dir", async () => {
    const page = await captureMemoryPage(root, projectA, {
      slug: "overview",
      type: "project",
      title: "Overview",
      tags: ["app"],
      content: "Alpha is the active project."
    });

    expect(page.projectId).toBe(projectA);
    await expect(
      readFile(path.join(projectDir(root, projectA), "memory", "pages", "overview.md"), "utf8")
    ).resolves.toContain("Alpha is the active project.");
  });

  it("lists, reads, and searches only the scoped project's pages", async () => {
    await captureMemoryPage(root, projectA, {
      slug: "preferences/testing",
      type: "preference",
      title: "Testing Preferences",
      tags: ["testing"],
      content: "Prefer Makefile targets and focused unit tests."
    });

    expect((await listMemoryPages(root, projectA))[0]).toMatchObject({
      projectId: projectA,
      slug: "preferences/testing"
    });
    expect((await getMemoryPage(root, projectA, "preferences/testing")).content).toContain("Makefile targets");
    expect((await searchMemoryPages(root, projectA, "unit tests"))[0]?.slug).toBe("preferences/testing");
  });

  it("isolates memory between projects", async () => {
    await captureMemoryPage(root, projectA, {
      slug: "secrets/alpha",
      type: "note",
      title: "Alpha note",
      tags: [],
      content: "Alpha-only knowledge about gateway tokens."
    });

    expect((await listMemoryPages(root, projectB))).toEqual([]);
    expect((await searchMemoryPages(root, projectB, "gateway tokens"))).toEqual([]);
    await expect(getMemoryPage(root, projectB, "secrets/alpha")).rejects.toThrow();
  });

  it("aggregates pages across projects with listAllMemoryPages", async () => {
    await captureMemoryPage(root, projectA, { slug: "a", type: "note", title: "A", tags: [], content: "alpha page" });
    await captureMemoryPage(root, projectB, { slug: "b", type: "note", title: "B", tags: [], content: "beta page" });

    const all = await listAllMemoryPages(root);
    expect(all.map((p) => `${p.projectId}:${p.slug}`).sort()).toEqual(
      [`${projectA}:a`, `${projectB}:b`].sort()
    );
  });

  it("deletes a memory page by slug within its project", async () => {
    await captureMemoryPage(root, projectA, {
      slug: "plans/launch",
      type: "project",
      title: "Launch plan",
      tags: ["plan"],
      content: "Plans delete by slug."
    });
    expect(await deleteMemoryPage(root, projectA, "plans/launch")).toBe(true);
    expect((await listMemoryPages(root, projectA)).map((p) => p.slug)).not.toContain("plans/launch");
    expect(await deleteMemoryPage(root, projectA, "plans/launch")).toBe(false);
  });

  it("exposes scoped memory inspection and capture through the API", async () => {
    const app = createServer({ root });

    await request(app)
      .post("/api/memory/pages")
      .send({
        projectId: projectA,
        slug: "decisions/storage",
        type: "decision",
        title: "Storage",
        tags: ["agents"],
        content: "The harness owns embedded gbrain memory."
      })
      .expect(201);

    const list = await request(app).get(`/api/memory/pages?projectId=${projectA}`).expect(200);
    expect(list.body[0].slug).toBe("decisions/storage");

    // Other project sees nothing.
    const otherList = await request(app).get(`/api/memory/pages?projectId=${projectB}`).expect(200);
    expect(otherList.body).toEqual([]);

    await request(app).post("/api/memory/index/rebuild").send({ projectId: projectA, targetPaths: [] }).expect(200);
    const search = await request(app)
      .get("/api/memory/index/search")
      .query({ projectId: projectA, q: "embedded gbrain" })
      .expect(200);
    expect(search.body[0]).toMatchObject({ sourceType: "memory", id: "memory:decisions/storage" });

    const page = await request(app)
      .get(`/api/memory/pages/decisions%2Fstorage?projectId=${projectA}`)
      .expect(200);
    expect(page.body.content).toContain("embedded gbrain memory");
  });

  it("requires projectId on memory routes", async () => {
    const app = createServer({ root });
    await request(app).get("/api/memory/pages").expect(400);
  });

  it("deletes a memory page through the API", async () => {
    const app = createServer({ root });

    await request(app)
      .post("/api/memory/pages")
      .send({ projectId: projectA, slug: "cleanup", type: "note", title: "Cleanup", tags: [], content: "Disposable." })
      .expect(201);

    await request(app).delete(`/api/memory/pages/cleanup?projectId=${projectA}`).expect(204);

    const list = await request(app).get(`/api/memory/pages?projectId=${projectA}`).expect(200);
    expect(list.body.map((p: { slug: string }) => p.slug)).not.toContain("cleanup");
    await request(app).delete(`/api/memory/pages/cleanup?projectId=${projectA}`).expect(404);
  });

  it("captures gbrain_propose memory locally without queueing a task", async () => {
    const { captureMemoryFromAgent } = await import("../src/memory/capture.ts");
    const { listTasks } = await import("../src/core/tasks/tasks.ts");

    const captured = await captureMemoryFromAgent(root, projectA, {
      slug: "preferences/local-only",
      title: "Local memory only",
      type: "preference",
      tags: ["personal"],
      content: "Memory stays on this machine.",
      rationale: "Personal wiki should not spawn harness tickets."
    });

    expect(captured).toMatchObject({ kind: "memory", status: "approved" });
    expect(await listTasks(root)).toHaveLength(0);
    expect((await getMemoryPage(root, projectA, "preferences/local-only")).content).toContain("stays on this machine");
  });
});
