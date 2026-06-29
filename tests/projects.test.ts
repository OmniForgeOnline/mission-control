import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import request from "supertest";

import { createServer } from "../src/server/app.ts";
import { onboardProject, listProjects, removeProject, updateProject } from "../src/core/projects/registry.ts";
import { pickerCommands, parsePickerOutput, pickFolder } from "../src/core/projects/folder-picker.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

describe("project registry", () => {
  let tmp: string;
  let repoDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "harness-projects-"));
    repoDir = path.join(tmp, "my-repo");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("onboards a project with a valid git repo", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: tmp });
    execSync("git config user.email test@test.com", { cwd: tmp });
    execSync("git config user.name test", { cwd: tmp });
    execSync("git init my-repo", { cwd: tmp });
    execSync("git config user.email test@test.com", { cwd: repoDir });
    execSync("git config user.name test", { cwd: repoDir });

    const project = await onboardProject(tmp, { repoPath: repoDir, name: "Test Repo" });
    expect(project.name).toBe("Test Repo");
    expect(project.status).toBe("active");
    expect(project.repoPath).toBeTruthy();
    expect(project.id).toMatch(/^proj-/);
  });

  it("returns an empty list on a fresh root", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: tmp });

    expect(await listProjects(tmp)).toEqual([]);
  });

  it("lists onboarded projects", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: tmp });
    execSync("git init repo-a", { cwd: tmp });
    execSync("git init repo-b", { cwd: tmp });

    await onboardProject(tmp, { repoPath: path.join(tmp, "repo-a") });
    await onboardProject(tmp, { repoPath: path.join(tmp, "repo-b") });

    const projects = await listProjects(tmp);
    expect(projects).toHaveLength(2);
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(["repo-a", "repo-b"]);
  });

  it("rejects duplicate repo paths", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init dupe", { cwd: tmp });

    await onboardProject(tmp, { repoPath: path.join(tmp, "dupe") });
    await expect(onboardProject(tmp, { repoPath: path.join(tmp, "dupe") })).rejects.toThrow(/already registered/);
  });

  it("rejects non-git paths", async () => {
    await expect(onboardProject(tmp, { repoPath: "/nonexistent/path" })).rejects.toThrow();
  });

  it("updates a project", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init my-repo", { cwd: tmp });

    const project = await onboardProject(tmp, { repoPath: repoDir });
    const updated = await updateProject(tmp, project.id, { name: "Renamed", status: "paused" });
    expect(updated.name).toBe("Renamed");
    expect(updated.status).toBe("paused");
  });

  it("removes a project and its state directory", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init my-repo", { cwd: tmp });

    const project = await onboardProject(tmp, { repoPath: repoDir });
    await removeProject(tmp, project.id);
    const projects = await listProjects(tmp);
    expect(projects).toEqual([]);
  });

  it("onboards the harness root as a normal project (no special-casing)", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: tmp });
    execSync("git config user.email test@test.com", { cwd: tmp });
    execSync("git config user.name test", { cwd: tmp });

    const project = await onboardProject(tmp, { repoPath: tmp, name: "Harness" });
    expect(project.id).toMatch(/^proj-/);
    expect(project.repoPath).toContain(path.basename(tmp));

    const projects = await listProjects(tmp);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(project.id);

    // The harness-rooted project can be updated and removed like any other.
    const updated = await updateProject(tmp, project.id, { status: "paused" });
    expect(updated.status).toBe("paused");
    await removeProject(tmp, project.id);
    expect(await listProjects(tmp)).toEqual([]);
  });

  it("rejects nested path with parent project", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init child-repo", { cwd: tmp });
    execSync("git init parent-repo", { cwd: path.join(tmp, "child-repo") });

    await onboardProject(tmp, { repoPath: path.join(tmp, "child-repo") });
    await expect(
      onboardProject(tmp, { repoPath: path.join(tmp, "child-repo", "parent-repo") })
    ).rejects.toThrow(/Path is nested with existing project "child-repo"/);
  });

  it("rejects nested path with child project", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init parent-repo", { cwd: tmp });
    execSync("git init child-repo", { cwd: path.join(tmp, "parent-repo") });

    await onboardProject(tmp, { repoPath: path.join(tmp, "parent-repo") });
    await expect(
      onboardProject(tmp, { repoPath: path.join(tmp, "parent-repo", "child-repo") })
    ).rejects.toThrow(/Path is nested with existing project "parent-repo"/);
  });

  it("defaults name to repo folder name when not provided", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init my-custom-folder", { cwd: tmp });

    const project = await onboardProject(tmp, { repoPath: path.join(tmp, "my-custom-folder") });
    expect(project.name).toBe("my-custom-folder");
  });
});

describe("project API", () => {
  let tmp: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "harness-proj-api-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: tmp });
    execSync("git config user.email t@t.com", { cwd: tmp });
    execSync("git config user.name t", { cwd: tmp });
    execSync("git commit --allow-empty -m init", { cwd: tmp });
    app = createServer({ root: tmp, testMode: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("GET /api/projects returns an empty list on a fresh root", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST /api/projects creates a project", async () => {
    const repoDir = path.join(tmp, "my-app");
    const { execSync } = await import("node:child_process");
    execSync("git init my-app", { cwd: tmp });

    const res = await request(app)
      .post("/api/projects")
      .send({ repoPath: repoDir, name: "My App" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("My App");
    expect(res.body.status).toBe("active");
  });

  it("POST /api/projects rejects missing repoPath", async () => {
    const res = await request(app).post("/api/projects").send({});
    expect(res.status).toBe(400);
  });

  it("PATCH /api/projects/:id updates a project", async () => {
    const repoDir = path.join(tmp, "my-app");
    const { execSync } = await import("node:child_process");
    execSync("git init my-app", { cwd: tmp });

    const createRes = await request(app).post("/api/projects").send({ repoPath: repoDir });
    const id = createRes.body.id;

    const res = await request(app).patch(`/api/projects/${id}`).send({ status: "paused" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paused");
  });

  it("DELETE /api/projects/:id removes a project", async () => {
    const repoDir = path.join(tmp, "my-app");
    const { execSync } = await import("node:child_process");
    execSync("git init my-app", { cwd: tmp });

    const createRes = await request(app).post("/api/projects").send({ repoPath: repoDir });
    const id = createRes.body.id;

    const res = await request(app).delete(`/api/projects/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("exposes an intake session for an onboarded project", async () => {
    const repoDir = path.join(tmp, "my-app");
    const { execSync } = await import("node:child_process");
    execSync("git init my-app", { cwd: tmp });
    const created = await request(app).post("/api/projects").send({ repoPath: repoDir, name: "My App" });
    const id = created.body.id as string;

    const res = await request(app).get(`/api/projects/${id}/intake/session`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual({ kind: "project", projectId: id });
  });

  it("GET /quickstarts returns the defaults for a freshly onboarded project", async () => {
    const repoDir = path.join(tmp, "my-app");
    const { execSync } = await import("node:child_process");
    execSync("git init my-app", { cwd: tmp });
    const created = await request(app).post("/api/projects").send({ repoPath: repoDir, name: "My App" });
    const id = created.body.id as string;

    const res = await request(app).get(`/api/projects/${id}/quickstarts`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.quickstarts)).toBe(true);
    expect(res.body.quickstarts.length).toBeGreaterThanOrEqual(3);
    expect(res.body.quickstarts.length).toBeLessThanOrEqual(6);
    for (const item of res.body.quickstarts) {
      expect(typeof item.label).toBe("string");
      expect(typeof item.prompt).toBe("string");
    }
  });

  it("reads and recomputes quality for a real project under its project dir", async () => {
    const repoDir = path.join(tmp, "my-app");
    const { execSync } = await import("node:child_process");
    execSync("git init my-app", { cwd: tmp });
    const created = await request(app).post("/api/projects").send({ repoPath: repoDir, name: "My App" });
    const id = created.body.id as string;

    const recompute = await request(app).post(`/api/projects/${id}/quality/recompute`);
    expect(recompute.status).toBe(200);
    expect(recompute.body).toHaveProperty("domains");

    const read = await request(app).get(`/api/projects/${id}/quality`);
    expect(read.status).toBe(200);
    expect(read.body).toHaveProperty("domains");
  });

  it("does not kick off background codex generation when onboarding in test mode", async () => {
    const repoDir = path.join(tmp, "my-app");
    const { execSync } = await import("node:child_process");
    execSync("git init my-app", { cwd: tmp });
    const created = await request(app).post("/api/projects").send({ repoPath: repoDir, name: "My App" });
    const id = created.body.id as string;

    // Onboarding must stay hermetic in test mode: no fire-and-forget generation
    // that would spawn a real codex subprocess. The gate stays at its pending
    // placeholder for the whole window instead of flipping to "generating".
    for (let i = 0; i < 8; i++) {
      const gate = await request(app).get(`/api/projects/${id}/quality-gate`);
      expect(gate.status).toBe(200);
      expect(gate.body.status).toBe("pending");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});

describe("projects quality-gate API", () => {
  let tmp: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "harness-qg-api-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: tmp });
    execSync("git config user.email t@t.com", { cwd: tmp });
    execSync("git config user.name t", { cwd: tmp });
    execSync("git commit --allow-empty -m init", { cwd: tmp });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  async function onboardPyProject(): Promise<string> {
    const repoDir = path.join(tmp, "svc");
    const { execSync } = await import("node:child_process");
    execSync("git init svc", { cwd: tmp });
    await writeFile(
      path.join(repoDir, "pyproject.toml"),
      "[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
      "utf8"
    );
    const created = await request(app).post("/api/projects").send({ repoPath: repoDir, name: "svc" });
    return created.body.id as string;
  }

  async function onboardEmptyRepo(): Promise<string> {
    const repoDir = path.join(tmp, "blank");
    const { execSync } = await import("node:child_process");
    execSync("git init blank", { cwd: tmp });
    const created = await request(app).post("/api/projects").send({ repoPath: repoDir, name: "blank" });
    return created.body.id as string;
  }

  it("regenerates a ready gate from agent output for a Python repo", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies([
      JSON.stringify({
        status: "ready",
        checks: [
          { name: "lint", category: "lint", command: "ruff check .", required: true, evidence: ["pyproject.toml [tool.ruff]"] },
          { name: "tests", category: "test", command: "pytest", required: true, evidence: ["pyproject.toml [tool.pytest]"] }
        ],
        rationale: "declared"
      })
    ]);
    app = createServer({ root: tmp, testMode: true, runner });

    const id = await onboardPyProject();
    const res = await request(app).post(`/api/projects/${id}/quality-gate/regenerate`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    const cmds = res.body.checks.map((c: { command: string }) => c.command);
    expect(cmds).toContain("ruff check .");
    expect(cmds).toContain("pytest");
  });

  it("regenerates a ready gate from deterministic synthesis when the agent fails", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies(["I cannot help with that"]);
    app = createServer({ root: tmp, testMode: true, runner });

    const id = await onboardPyProject();
    const res = await request(app).post(`/api/projects/${id}/quality-gate/regenerate`);
    expect(res.status).toBe(200);
    // No generic gate: the correct per-project commands are synthesized from evidence.
    expect(res.body.status).toBe("ready");
    const cmds = res.body.checks.map((c: { command: string }) => c.command);
    expect(cmds).toContain("ruff check .");
    expect(cmds).toContain("pytest");
  });

  it("regenerates an incomplete gate (never generic) for an evidence-less repo", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies(["nope"]);
    app = createServer({ root: tmp, testMode: true, runner });

    const id = await onboardEmptyRepo();
    const res = await request(app).post(`/api/projects/${id}/quality-gate/regenerate`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("incomplete");
    expect(res.body.checks).toEqual([]);
    expect(res.body.needsResolution.length).toBeGreaterThan(0);
  });

  it("GET /quality-gate returns the stored config after regeneration", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies(["garbage"]);
    app = createServer({ root: tmp, testMode: true, runner });

    const id = await onboardPyProject();
    await request(app).post(`/api/projects/${id}/quality-gate/regenerate`);
    const read = await request(app).get(`/api/projects/${id}/quality-gate`);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe("ready");
    expect(read.body.generatedAt).toBeTruthy();
  });
});

describe("project folder picker", () => {
  it("returns the macOS osascript command on darwin", () => {
    const commands = pickerCommands("darwin");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("osascript");
    expect(commands[0]?.args.join(" ")).toContain("choose folder");
  });

  it("returns the Windows PowerShell folder dialog on win32 with STA", () => {
    const commands = pickerCommands("win32");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("powershell");
    expect(commands[0]?.args).toContain("-STA");
    expect(commands[0]?.args.join(" ")).toContain("FolderBrowserDialog");
  });

  it("returns zenity then kdialog candidates on linux", () => {
    const commands = pickerCommands("linux");
    expect(commands.map((c) => c.command)).toEqual(["zenity", "kdialog"]);
  });

  it("returns no candidates on unsupported platforms", () => {
    expect(pickerCommands("freebsd" as NodeJS.Platform)).toEqual([]);
  });

  it("parses a chosen path and treats empty output as cancel", () => {
    expect(parsePickerOutput("/Users/me/repos/app\n")).toBe("/Users/me/repos/app");
    expect(parsePickerOutput("   \n")).toBeNull();
    expect(parsePickerOutput("")).toBeNull();
  });

  it("reports unavailable when the platform has no picker", async () => {
    const result = await pickFolder("freebsd" as NodeJS.Platform);
    expect(result).toEqual({ unavailable: true });
  });
});
