import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { onboardProject } from "../src/core/projects/registry.ts";
import {
  validateProjectJobDefinition,
  PROJECT_JOB_JSON_SCHEMA,
  type ProjectJobDefinition
} from "../src/core/projects/job-schema.ts";
import { defineProjectJob, listProjectJobs } from "../src/core/projects/scoped-autonomy.ts";
import { callTool } from "../src/mcp/tool-registry.ts";

const VALID_JOB: ProjectJobDefinition = {
  id: "dependency-audit",
  title: "Dependency audit",
  description: "Review outdated dependencies and capture upgrade tasks.",
  schedule: "every-7d",
  runMode: "manual",
  approvalPolicy: "synthetic-task",
  instructions: "Inspect the lockfile for outdated deps; file tech_debt_capture for each risky upgrade."
};

describe("project job-definition schema", () => {
  describe("validateProjectJobDefinition", () => {
    it("accepts a valid job definition", () => {
      const result = validateProjectJobDefinition(VALID_JOB);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.id).toBe("dependency-audit");
        expect(result.job.instructions).toBe(VALID_JOB.instructions);
      }
    });

    it("trims authored string fields", () => {
      const result = validateProjectJobDefinition({ ...VALID_JOB, title: "  Spaced title  " });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.job.title).toBe("Spaced title");
    });

    it("rejects a bad id", () => {
      const result = validateProjectJobDefinition({ ...VALID_JOB, id: "Bad ID!" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toMatch(/id/);
    });

    it("rejects a bad schedule", () => {
      const result = validateProjectJobDefinition({ ...VALID_JOB, schedule: "daily" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toMatch(/schedule/);
    });

    it("schedule: the JSON-schema pattern and runtime validator agree on zero and garbage", () => {
      // The machine-readable schema pattern and parseSchedule must not disagree.
      // An agent reading the schema must not be able to submit an interval the
      // runtime validator rejects (e.g. every-0m). Both accept the valid set and
      // both reject the zero/garbage set.
      const schemaPattern = new RegExp(PROJECT_JOB_JSON_SCHEMA.properties.schedule.pattern);
      const accepted = ["every-1m", "every-30m", "every-1h", "every-1d"];
      const rejected = ["every-0m", "every-00d", "every-0h", "daily", "every-"];
      for (const schedule of accepted) {
        expect(schemaPattern.test(schedule)).toBe(true);
        expect(validateProjectJobDefinition({ ...VALID_JOB, schedule }).ok).toBe(true);
      }
      for (const schedule of rejected) {
        expect(schemaPattern.test(schedule)).toBe(false);
        expect(validateProjectJobDefinition({ ...VALID_JOB, schedule }).ok).toBe(false);
      }
    });

    it("rejects unknown properties to honor additionalProperties:false", () => {
      const result = validateProjectJobDefinition({ ...VALID_JOB, bogus: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toMatch(/bogus/);
    });

    it("rejects an unknown approval policy", () => {
      const result = validateProjectJobDefinition({ ...VALID_JOB, approvalPolicy: "delete-everything" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toMatch(/approvalPolicy/);
    });

    it("rejects an unknown run mode", () => {
      const result = validateProjectJobDefinition({ ...VALID_JOB, runMode: "sometimes" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toMatch(/runMode/);
    });

    it("rejects missing required fields", () => {
      const result = validateProjectJobDefinition({ id: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(1);
    });

    it("rejects non-object input", () => {
      expect(validateProjectJobDefinition(null).ok).toBe(false);
      expect(validateProjectJobDefinition("nope").ok).toBe(false);
      expect(validateProjectJobDefinition([]).ok).toBe(false);
    });

    it("exposes a machine-readable JSON schema with the required fields", () => {
      expect(PROJECT_JOB_JSON_SCHEMA.required).toEqual(
        expect.arrayContaining(["id", "title", "description", "schedule", "runMode", "approvalPolicy"])
      );
      expect(PROJECT_JOB_JSON_SCHEMA.properties).toHaveProperty("instructions");
    });
  });

  describe("defineProjectJob", () => {
    let root: string;
    let projectId: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "harness-job-schema-"));
      await ensureHarnessRepository(root);
      const repo = path.join(root, "app");
      execSync("git init app", { cwd: root });
      execSync("git config user.email t@t.com", { cwd: repo });
      execSync("git config user.name t", { cwd: repo });
      await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "some-app" }), "utf8");
      const project = await onboardProject(root, { repoPath: repo, name: "App" });
      projectId = project.id;
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    });

    it("registers a validated custom job with instructions", async () => {
      const result = await defineProjectJob(root, projectId, VALID_JOB);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.id).toBe("dependency-audit");
        expect(result.job.instructions).toBe(VALID_JOB.instructions);
        expect(result.job.status).toBe("active");
      }
      const stored = (await listProjectJobs(root, projectId)).find((j) => j.id === "dependency-audit");
      expect(stored).toBeDefined();
      expect(stored?.instructions).toBe(VALID_JOB.instructions);
    });

    it("requires instructions for jobs without a built-in handler", async () => {
      const result = await defineProjectJob(root, projectId, { ...VALID_JOB, instructions: undefined });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toMatch(/instructions/);
    });

    it("accepts a built-in id without instructions", async () => {
      const result = await defineProjectJob(root, projectId, {
        id: "tech-debt-sweep",
        title: "Tech debt sweep",
        description: "Re-tune the tech debt sweep cadence.",
        schedule: "every-3d",
        runMode: "manual",
        approvalPolicy: "synthetic-task"
      });
      expect(result.ok).toBe(true);
    });

    it("rejects an invalid definition and persists nothing", async () => {
      const before = await listProjectJobs(root, projectId);
      const result = await defineProjectJob(root, projectId, { ...VALID_JOB, schedule: "whenever" });
      expect(result.ok).toBe(false);
      const after = await listProjectJobs(root, projectId);
      expect(after.map((j) => j.id)).not.toContain("dependency-audit");
      expect(after.length).toBe(before.length);
    });

    it("updates an existing custom job in place without duplicating", async () => {
      await defineProjectJob(root, projectId, VALID_JOB);
      const again = await defineProjectJob(root, projectId, { ...VALID_JOB, title: "Dependency audit v2" });
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.job.title).toBe("Dependency audit v2");
      const stored = (await listProjectJobs(root, projectId)).filter((j) => j.id === "dependency-audit");
      expect(stored).toHaveLength(1);
    });

    it("validates a job through the MCP tool surface", async () => {
      const valid = await callTool({ root, runId: "test" }, "validate_project_job", { job: VALID_JOB });
      expect(JSON.parse((valid as { content: { text: string }[] }).content[0]!.text).valid).toBe(true);
      const invalid = await callTool({ root, runId: "test" }, "validate_project_job", {
        job: { ...VALID_JOB, schedule: "nope" }
      });
      expect(JSON.parse((invalid as { content: { text: string }[] }).content[0]!.text).valid).toBe(false);
    });

    it("registers a job through the MCP tool surface", async () => {
      const out = await callTool({ root, runId: "test" }, "define_project_job", {
        projectId,
        job: VALID_JOB
      });
      const payload = JSON.parse((out as { content: { text: string }[] }).content[0]!.text);
      expect(payload.ok).toBe(true);
      expect((await listProjectJobs(root, projectId)).map((j) => j.id)).toContain("dependency-audit");
    });
  });
});
