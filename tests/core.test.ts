import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runChecks, summarizeFailures } from "../src/core/review/checks.ts";
import {
  listFileNames,
  readJsonFile,
  safeRootPath,
  writeFileIfMissing,
  writeJsonFile
} from "../src/core/infra/fs.ts";

describe("core fs helpers", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-core-fs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("readJsonFile returns fallback when the file is missing", async () => {
    const value = await readJsonFile(path.join(root, "missing.json"), { ok: true });
    expect(value).toEqual({ ok: true });
  });

  it("writeJsonFile round-trips structured data", async () => {
    const filePath = path.join(root, "nested", "data.json");
    await writeJsonFile(filePath, { count: 2, tags: ["a"] });
    const raw = await readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual({ count: 2, tags: ["a"] });
  });

  it("writeFileIfMissing preserves an existing file", async () => {
    const filePath = path.join(root, "seed.txt");
    await writeFile(filePath, "original", "utf8");
    await writeFileIfMissing(filePath, "replacement");
    expect(await readFile(filePath, "utf8")).toBe("original");
  });

  it("writeFileIfMissing creates a missing file", async () => {
    const filePath = path.join(root, "new.txt");
    await writeFileIfMissing(filePath, "created");
    expect(await readFile(filePath, "utf8")).toBe("created");
  });

  it("safeRootPath rejects absolute and escape paths", () => {
    expect(() => safeRootPath(root, "/etc/passwd")).toThrow(/relative/);
    expect(() => safeRootPath(root, "../outside")).toThrow(/inside the harness root/);
  });

  it("safeRootPath resolves relative paths inside the root", () => {
    expect(safeRootPath(root, "data/state/tasks.json")).toBe(
      path.resolve(root, "data/state/tasks.json")
    );
  });

  it("listFileNames returns an empty array for a missing directory", async () => {
    expect(await listFileNames(path.join(root, "missing-dir"))).toEqual([]);
  });
});

describe("core checks", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-core-checks-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeChecksFile(content: string): Promise<void> {
    const dir = path.join(root, ".harness");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "checks.yml"), content, "utf8");
  }

  it("runChecks reports noChecks when nothing is configured", async () => {
    const summary = await runChecks(root);
    expect(summary.outcome).toBe("noChecks");
    expect(summary.skipped).toBe(true);
    expect(summary.pass).toBe(true);
    expect(summary.source).toBe("none");
    expect(summary.results).toEqual([]);
  });

  it("runChecks runs configured commands and records failures", async () => {
    await writeChecksFile(`
checks:
  - name: ok
    command: echo pass
  - name: fail
    command: exit 1
`);
    const summary = await runChecks(root);
    expect(summary.outcome).toBe("failed");
    expect(summary.skipped).toBe(false);
    expect(summary.pass).toBe(false);
    expect(summary.source).toBe("checks.yml");
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0]).toMatchObject({ name: "ok", status: "passed" });
    expect(summary.results[1]).toMatchObject({ name: "fail", status: "failed" });
  });

  it("summarizeFailures returns empty string when all checks pass", async () => {
    await writeChecksFile(`
checks:
  - name: ok
    command: echo pass
`);
    const summary = await runChecks(root);
    expect(summarizeFailures(summary)).toBe("");
  });

  it("summarizeFailures formats failed check output and ignores skips", () => {
    const text = summarizeFailures({
      outcome: "failed",
      pass: false,
      skipped: false,
      source: "checks.yml",
      maxRounds: 3,
      results: [
        {
          name: "lint",
          command: "npm run lint",
          status: "failed",
          exitCode: 2,
          output: "lint failed"
        },
        {
          name: "typecheck",
          command: "make typecheck",
          status: "skipped",
          exitCode: 0,
          output: "",
          skipReason: "no typecheck target declared in Makefile"
        }
      ]
    });
    expect(text).toContain("### lint");
    expect(text).toContain("Exit code: 2");
    expect(text).toContain("lint failed");
    expect(text).not.toContain("typecheck");
  });
});