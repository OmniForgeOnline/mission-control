import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_CHECK_REMEDIATION_ROUNDS,
  describeCheckPlan,
  describeChecksOutcome,
  planChecks,
  resolveCheckMaxRounds,
  runCheckPlan
} from "../src/core/review/checks.ts";

describe("checks outcome descriptions", () => {
  it("makes a no-checks workspace loud, not a silent pass", () => {
    const message = describeChecksOutcome({
      outcome: "noChecks",
      pass: true,
      skipped: true,
      source: "none",
      results: [],
      maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS
    });
    expect(message).toContain("No mechanical checks");
    expect(message).toContain("Nothing was validated");
  });

  it("names what was probed when package.json declares no scripts", () => {
    const message = describeChecksOutcome({
      outcome: "noChecks",
      pass: true,
      skipped: true,
      source: "package.json",
      results: [],
      maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS
    });
    expect(message).toContain("package.json");
    expect(message).toContain("Nothing was validated");
  });

  it("names both files when a hybrid plan ran nothing usable", () => {
    const message = describeChecksOutcome({
      outcome: "noChecks",
      pass: true,
      skipped: true,
      source: "hybrid",
      results: [],
      maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS
    });
    expect(message).toContain("package.json");
    expect(message).toContain("Makefile");
    expect(message).toContain("Nothing was validated");
  });

  it("describes validated checks with command names", () => {
    const message = describeChecksOutcome({
      outcome: "validated",
      pass: true,
      skipped: false,
      source: "checks.yml",
      maxRounds: 3,
      results: [
        { name: "lint", command: "npm run lint", status: "passed", exitCode: 0, output: "" },
        { name: "test", command: "npm test", status: "passed", exitCode: 0, output: "" }
      ]
    });
    expect(message).toContain("passed");
    expect(message).toContain("lint");
    expect(message).toContain("test");
  });

  it("surfaces skipped checks alongside a validated outcome", () => {
    const message = describeChecksOutcome({
      outcome: "validated",
      pass: true,
      skipped: false,
      source: "package.json",
      maxRounds: 3,
      results: [
        { name: "lint", command: "npm run -s lint", status: "passed", exitCode: 0, output: "" },
        {
          name: "typecheck",
          command: "npm run -s typecheck",
          status: "skipped",
          exitCode: 0,
          output: "",
          skipReason: "no typecheck/type-check script declared in package.json"
        }
      ]
    });
    expect(message).toContain("passed");
    expect(message).toContain("Skipped");
    expect(message).toContain("typecheck");
    expect(message).toContain("tooling unavailable");
  });
});

describe("checks project-aware planner", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-checks-plan-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeChecksFile(content: string): Promise<void> {
    const dir = path.join(root, ".harness");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "checks.yml"), content, "utf8");
  }

  it("prefers an explicit .harness/checks.yml and marks every entry available", async () => {
    await writeChecksFile("maxRounds: 4\nchecks:\n  - name: lint\n    command: npm run lint\n");
    const plan = await planChecks(root);
    expect(plan.source).toBe("checks.yml");
    expect(plan.maxRounds).toBe(4);
    expect(plan.checks).toEqual([
      { name: "lint", command: "npm run lint", available: true }
    ]);
  });

  it("detects lint/test/typecheck scripts from package.json via the lockfile package manager", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }),
      "utf8"
    );
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");

    const plan = await planChecks(root);
    expect(plan.source).toBe("package.json");
    const lint = plan.checks.find((check) => check.name === "lint");
    const testCheck = plan.checks.find((check) => check.name === "test");
    const typecheck = plan.checks.find((check) => check.name === "typecheck");
    expect(lint).toMatchObject({ available: true, command: "npm run -s lint", kind: "lint" });
    expect(testCheck).toMatchObject({ available: true, command: "npm run -s test", kind: "test" });
    expect(typecheck).toMatchObject({
      available: false,
      kind: "typecheck",
      skipReason: expect.stringContaining("typecheck")
    });
  });

  it("selects the yarn runner when yarn.lock is present", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
      "utf8"
    );
    await writeFile(path.join(root, "yarn.lock"), "", "utf8");

    const plan = await planChecks(root);
    const lint = plan.checks.find((check) => check.name === "lint");
    expect(lint?.command).toBe("yarn run lint");
  });

  it("detects checks from Makefile targets", async () => {
    await writeFile(path.join(root, "Makefile"), "lint:\n\techo hi\n\ntest:\n\tvitest run\n", "utf8");
    const plan = await planChecks(root);
    expect(plan.source).toBe("makefile");
    const lint = plan.checks.find((check) => check.name === "lint");
    const testCheck = plan.checks.find((check) => check.name === "test");
    const typecheck = plan.checks.find((check) => check.name === "typecheck");
    expect(lint).toMatchObject({ available: true, command: "make lint" });
    expect(testCheck).toMatchObject({ available: true, command: "make test" });
    expect(typecheck).toMatchObject({ available: false });
  });

  it("fills a kind missing from package.json from a Makefile target (hybrid plan)", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }),
      "utf8"
    );
    await writeFile(path.join(root, "Makefile"), "typecheck:\n\ttsc --noEmit\n", "utf8");

    const plan = await planChecks(root);
    expect(plan.source).toBe("hybrid");
    const lint = plan.checks.find((check) => check.name === "lint");
    const testCheck = plan.checks.find((check) => check.name === "test");
    const typecheck = plan.checks.find((check) => check.name === "typecheck");
    // package.json scripts win where declared ...
    expect(lint).toMatchObject({ available: true, command: "npm run -s lint" });
    expect(testCheck).toMatchObject({ available: true, command: "npm run -s test" });
    // ... and a Makefile target satisfies the kind package.json did not declare,
    // instead of being silently marked skipped.
    expect(typecheck).toMatchObject({ available: true, command: "make typecheck" });
  });

  it("prefers a package.json script over a Makefile target for the same kind", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
      "utf8"
    );
    await writeFile(path.join(root, "Makefile"), "lint:\n\techo make-lint\n", "utf8");

    const plan = await planChecks(root);
    const lint = plan.checks.find((check) => check.name === "lint");
    expect(lint).toMatchObject({ available: true, command: "npm run -s lint" });
  });

  it("combines reasons when a kind is unavailable in both package.json and Makefile", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
      "utf8"
    );
    await writeFile(path.join(root, "Makefile"), "lint:\n\techo hi\n", "utf8");

    const plan = await planChecks(root);
    expect(plan.source).toBe("hybrid");
    const typecheck = plan.checks.find((check) => check.name === "typecheck");
    expect(typecheck).toMatchObject({ available: false });
    expect(typecheck?.skipReason).toContain("package.json");
    expect(typecheck?.skipReason).toContain("Makefile");
  });

  it("reports source none and no checks for a workspace with no declarations", async () => {
    const plan = await planChecks(root);
    expect(plan.source).toBe("none");
    expect(plan.checks).toEqual([]);
  });
});

describe("checks plan prompt rendering", () => {
  it("lists the exact detected commands for the author to run", () => {
    const text = describeCheckPlan({
      source: "package.json",
      maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
      checks: [
        { name: "lint", kind: "lint", command: "npm run -s lint", available: true },
        { name: "test", kind: "test", command: "npm run -s test", available: true },
        {
          name: "typecheck",
          kind: "typecheck",
          command: "npm run -s typecheck",
          available: false,
          skipReason: "no typecheck script declared in package.json"
        }
      ]
    });
    expect(text).toContain("`npm run -s lint`");
    expect(text).toContain("`npm run -s test`");
    // Unavailable checks are surfaced so the author does not invent a substitute.
    expect(text).toContain("Unavailable");
    expect(text).toContain("typecheck");
    expect(text).not.toContain("`npm run -s typecheck`");
  });

  it("prefixes a check's command with its cwd so the author runs it where the gate does", () => {
    const text = describeCheckPlan({
      source: "quality-gate",
      maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
      checks: [
        { name: "lint", kind: "lint", command: "ruff check .", available: true, cwd: "services/api" },
        { name: "typecheck", kind: "typecheck", command: "tsc --noEmit", available: true }
      ]
    });
    // A cwd-bearing check must point the author at the subdirectory the gate runs
    // from; otherwise a bare `ruff check .` at the workspace root does not reproduce it.
    expect(text).toContain("cd services/api && ruff check .");
    // A check without a cwd stays bare, so the author is not sent to a phantom directory.
    expect(text).toContain("`tsc --noEmit`");
    expect(text).not.toMatch(/cd .+ && tsc --noEmit/);
  });

  it("states plainly when no checks are available and there is no automated gate", () => {
    const text = describeCheckPlan({
      source: "none",
      maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
      checks: []
    });
    expect(text).toContain("No");
    expect(text).toContain("will not run an automated gate");
  });
});

describe("checks remediation helpers", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-commit-remediation-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolveCheckMaxRounds falls back to the default when checks.yml is missing", async () => {
    await expect(resolveCheckMaxRounds(root)).resolves.toBe(DEFAULT_CHECK_REMEDIATION_ROUNDS);
  });

  it("resolveCheckMaxRounds reads maxRounds from checks.yml", async () => {
    const dir = path.join(root, ".harness");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "checks.yml"), "maxRounds: 5\nchecks:\n  - name: ok\n    command: echo pass\n", "utf8");
    await expect(resolveCheckMaxRounds(root)).resolves.toBe(5);
  });
});

describe("runCheckPlan working directory", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "harness-checks-cwd-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("runs a check in its declared cwd, resolved against the workspace root", async () => {
    const subdir = path.join(workspace, "services", "api");
    await mkdir(subdir, { recursive: true });
    const summary = await runCheckPlan(
      {
        source: "checks.yml",
        maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
        checks: [
          { name: "where", command: 'node -e "console.log(process.cwd())"', available: true, cwd: "services/api" }
        ]
      },
      workspace
    );
    expect(summary.outcome).toBe("validated");
    expect(summary.results[0]?.output).toContain(subdir);
  });

  it("runs a check at the workspace root when no cwd is declared", async () => {
    const summary = await runCheckPlan(
      {
        source: "checks.yml",
        maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
        checks: [{ name: "where", command: 'node -e "console.log(process.cwd())"', available: true }]
      },
      workspace
    );
    expect(summary.results[0]?.output).toContain(workspace);
  });
});
