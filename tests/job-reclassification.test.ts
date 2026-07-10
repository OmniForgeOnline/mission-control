import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

import { listAutonomyJobs } from "../src/autonomy/jobs.ts";
import { writeJsonFile } from "../src/core/infra/fs.ts";
import { jobsPath } from "../src/autonomy/job-types.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject, projectDir } from "../src/core/projects/registry.ts";
import { listProjectJobs, runProjectJob } from "../src/core/projects/scoped-autonomy.ts";
import { captureMemoryPage } from "../src/memory/store.ts";
import {
  buildProjectDocGardeningContext,
  buildProjectDocGardeningPrompt
} from "../src/autonomy/handlers/project-doc-gardening.ts";
import type { ProjectRecord } from "../src/core/projects/registry.ts";

const GLOBAL_MAINTENANCE_IDS = [
  "clickup-ticket-sync",
  "merge-status-sweep",
  "workflow-reconcile-sweep",
  "worktree-cleanup-sweep"
];

describe("autonomy job reclassification", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-reclass-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  describe("global maintenance jobs", () => {
    it("seeds only cross-cutting daemon-maintenance jobs", async () => {
      const jobs = await listAutonomyJobs(root);
      expect(jobs.map((j) => j.id).sort()).toEqual(GLOBAL_MAINTENANCE_IDS);
    });

    it("does not seed the per-project jobs as globals", async () => {
      const ids = (await listAutonomyJobs(root)).map((j) => j.id);
      expect(ids).not.toContain("memory-index-refresh");
      expect(ids).not.toContain("doc-gardening");
    });

    it("pauses clickup-ticket-sync by default", async () => {
      const jobs = await listAutonomyJobs(root);
      expect(jobs.find((j) => j.id === "clickup-ticket-sync")?.status).toBe("paused");
    });

    it("keeps worktree + workflow sweeps active", async () => {
      const jobs = await listAutonomyJobs(root);
      expect(jobs.find((j) => j.id === "merge-status-sweep")?.status).toBe("active");
      expect(jobs.find((j) => j.id === "worktree-cleanup-sweep")?.status).toBe("active");
      expect(jobs.find((j) => j.id === "workflow-reconcile-sweep")?.status).toBe("active");
    });

    it("prunes stored global jobs that are no longer defaults", async () => {
      await writeJsonFile(jobsPath(root), [
        {
          id: "memory-index-refresh",
          title: "Memory index refresh",
          description: "stale global job",
          schedule: "every-1h",
          status: "active",
          runMode: "manual",
          approvalPolicy: "read-only"
        },
        {
          id: "quality-grade-update",
          title: "Quality grade update",
          description: "stale project-domain job left in globals",
          schedule: "every-7d",
          status: "active",
          runMode: "manual",
          approvalPolicy: "read-only"
        },
        {
          id: "worktree-cleanup-sweep",
          title: "Worktree cleanup sweep",
          description: "kept",
          schedule: "every-1h",
          status: "active",
          runMode: "automatic",
          approvalPolicy: "read-only"
        }
      ]);

      const ids = (await listAutonomyJobs(root)).map((j) => j.id).sort();
      expect(ids).toEqual(GLOBAL_MAINTENANCE_IDS);
    });

    it("preserves operator-set status on a stored clickup-ticket-sync job", async () => {
      await writeJsonFile(jobsPath(root), [
        {
          id: "clickup-ticket-sync",
          title: "ClickUp ticket sync",
          description: "Poll subscribed ClickUp lists for @omc tickets and mirror harness lifecycle updates upstream.",
          schedule: "every-5m",
          status: "active",
          runMode: "automatic",
          approvalPolicy: "synthetic-task"
        }
      ]);

      const job = (await listAutonomyJobs(root)).find((j) => j.id === "clickup-ticket-sync");
      expect(job?.status).toBe("active");
    });
  });

  describe("per-project reclassified jobs", () => {
    let projectId: string;
    let project: ProjectRecord;

    beforeEach(async () => {
      const repo = path.join(root, "my-repo");
      execSync("git init my-repo", { cwd: root });
      execSync("git config user.email t@t.com", { cwd: repo });
      execSync("git config user.name t", { cwd: repo });
      project = await onboardProject(root, { repoPath: repo, name: "Acme App" });
      projectId = project.id;
    });

    it("seeds memory-index-refresh and doc-gardening as project jobs", async () => {
      const ids = (await listProjectJobs(root, projectId)).map((j) => j.id);
      expect(ids).toContain("memory-index-refresh");
      expect(ids).toContain("doc-gardening");
    });

    it("does not seed the harness guidance sweep for a non-harness project", async () => {
      const ids = (await listProjectJobs(root, projectId)).map((j) => j.id);
      expect(ids).not.toContain("guidance-sweep");
    });

    it("rebuilds only that project's memory index on memory-index-refresh", async () => {
      await captureMemoryPage(root, projectId, {
        slug: "overview/api",
        type: "overview",
        title: "API overview",
        content: "The API exposes a /health endpoint."
      });

      const result = await runProjectJob(root, projectId, "memory-index-refresh");

      expect(result.status).toBe("completed");
      expect(result.summary.toLowerCase()).toContain("document");
      await expect(
        import("node:fs/promises").then((fs) =>
          fs.access(path.join(projectDir(root, projectId), "memory-index", "documents.json"))
        )
      ).resolves.toBeUndefined();
    });

    it("doc-gardening context scans the project's own docs + per-project memory", async () => {
      await writeFile(path.join(project.repoPath, "README.md"), "# Acme App\n\nRun `acme start` to boot.\n", "utf8");
      await captureMemoryPage(root, projectId, {
        slug: "decisions/auth",
        type: "decision",
        title: "Auth decision",
        content: "We use session cookies."
      });

      const context = await buildProjectDocGardeningContext(root, project);
      expect(context).toContain("README.md");
      expect(context).toContain("Auth decision");
    });

    it("doc-gardening prompt is project-scoped and avoids kernel-only proposals", async () => {
      const prompt = buildProjectDocGardeningPrompt(project, "ctx");
      expect(prompt).toContain("Acme App");
      expect(prompt).toContain(`tech_debt_capture(projectId: "${projectId}")`);
      expect(prompt).toContain(`gbrain_propose(projectId: "${projectId}")`);
      // The kernel proposal tools must be explicitly forbidden, not invoked.
      expect(prompt).toContain("Do NOT use `propose_rule`");
    });
  });

  describe("harness project guidance sweep", () => {
    let harnessProjectId: string;

    beforeEach(async () => {
      const repo = path.join(root, "mission-control-src");
      execSync("git init mission-control-src", { cwd: root });
      execSync("git config user.email t@t.com", { cwd: repo });
      execSync("git config user.name t", { cwd: repo });
      await writeFile(
        path.join(repo, "package.json"),
        JSON.stringify({ name: "@omniforge/mission-control", version: "0.0.0" }),
        "utf8"
      );
      const project = await onboardProject(root, { repoPath: repo, name: "mission-control" });
      harnessProjectId = project.id;
    });

    it("seeds the guidance sweep only for the harness project", async () => {
      const jobs = await listProjectJobs(root, harnessProjectId);
      expect(jobs.map((j) => j.id)).toContain("guidance-sweep");
      expect(jobs.find((j) => j.id === "guidance-sweep")).toMatchObject({
        status: "paused",
        runMode: "manual",
        approvalPolicy: "proposal-only",
        schedule: "every-1d"
      });
    });

    it("runs the guidance sweep as a project-scoped handler with project context", async () => {
      // The handler builds context from the project repo (kernel/README). Verified
      // via the builder, since the handler spawns a real agent turn.
      const project = await import("../src/core/projects/registry.ts").then((m) => m.getProject(root, harnessProjectId));
      const { buildGuidanceSweepContext } = await import("../src/autonomy/guidance-sweep.ts");
      await writeFile(
        path.join(project!.repoPath, "README.md"),
        "# Mission Control\n\nThe harness repository is the system of record.\n",
        "utf8"
      );
      const context = await buildGuidanceSweepContext(project!.repoPath);
      expect(context).toContain("README.md");
      expect(context).toContain("system of record");
    });
  });
});
