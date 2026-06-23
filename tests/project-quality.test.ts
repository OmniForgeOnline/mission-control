import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { computeProjectQualityGrades } from "../src/core/quality/quality.ts";

describe("project quality grading", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "harness-quality-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("discovers src/ domains in a project repo", async () => {
    const srcDir = path.join(tmp, "src");
    await mkdir(path.join(srcDir, "utils"), { recursive: true });
    await writeFile(path.join(srcDir, "utils", "helpers.ts"), "export const x = 1;\n");

    const result = await computeProjectQualityGrades(tmp, tmp);
    expect(result.skipped).toBeFalsy();
    expect(Object.keys(result.domains)).toContain("utils");
  });

  it("discovers app/ domains", async () => {
    const appDir = path.join(tmp, "app");
    await mkdir(path.join(appDir, "routes"), { recursive: true });
    await writeFile(path.join(appDir, "routes", "index.ts"), "export default {};\n");

    const result = await computeProjectQualityGrades(tmp, tmp);
    expect(Object.keys(result.domains)).toContain("routes");
  });

  it("skips repos with no recognized source roots", async () => {
    await mkdir(path.join(tmp, "config"), { recursive: true });
    await writeFile(path.join(tmp, "config", "settings.yaml"), "key: value\n");

    const result = await computeProjectQualityGrades(tmp, tmp);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/no recognized source root/i);
  });

  it("discovers apps/* subdirectories as domains", async () => {
    const appsDir = path.join(tmp, "apps");
    await mkdir(path.join(appsDir, "web", "src"), { recursive: true });
    await mkdir(path.join(appsDir, "api", "src"), { recursive: true });
    await writeFile(path.join(appsDir, "web", "src", "main.ts"), "export {};\n");
    await writeFile(path.join(appsDir, "api", "src", "server.ts"), "export {};\n");

    const result = await computeProjectQualityGrades(tmp, tmp);
    expect(Object.keys(result.domains)).toContain("web");
    expect(Object.keys(result.domains)).toContain("api");
  });

  it("discovers packages/* subdirectories as domains", async () => {
    const pkgDir = path.join(tmp, "packages");
    await mkdir(path.join(pkgDir, "core", "src"), { recursive: true });
    await writeFile(path.join(pkgDir, "core", "src", "index.ts"), "export {};\n");

    const result = await computeProjectQualityGrades(tmp, tmp);
    expect(Object.keys(result.domains)).toContain("core");
  });
});
