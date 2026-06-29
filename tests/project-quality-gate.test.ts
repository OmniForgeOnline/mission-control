import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { onboardProject, type ProjectRecord } from "../src/core/projects/registry.ts";
import { gatherProjectIntel, type ProjectIntel } from "../src/core/projects/intel.ts";
import {
  isMutatingCommand,
  isVerificationCategory,
  parseAndValidateQualityGate,
  readProjectQualityGate,
  synthesizeGateFromIntel,
  writeQualityGate
} from "../src/core/projects/quality-gate.ts";
import { generateProjectQualityGate } from "../src/core/projects/quality-gate-generation.ts";
import { planProjectChecks } from "../src/core/projects/project-checks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

function repliesRunner(reply: string): DeterministicAgentRunner {
  const runner = new DeterministicAgentRunner("claude");
  runner.setReplies([reply]);
  return runner;
}

const READY_RUFF = JSON.stringify({
  status: "ready",
  checks: [
    {
      name: "lint",
      category: "lint",
      command: "ruff check .",
      required: true,
      evidence: ["pyproject.toml [tool.ruff]"]
    }
  ],
  rationale: "Ruff is declared in pyproject.toml."
});

describe("synthesizeGateFromIntel", () => {
  it("builds a ready config from evidence-backed commands, carrying the source as evidence", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-qg-synth-"));
    try {
      await writeFile(
        path.join(tmp, "pyproject.toml"),
        "[tool.pytest.ini_options]\n[tool.ruff]\n",
        "utf8"
      );
      const intel = await gatherProjectIntel(tmp);
      const file = synthesizeGateFromIntel(intel);

      expect(file.status).toBe("ready");
      expect(file.checks.length).toBe(2);
      const ruff = file.checks.find((c) => c.command === "ruff check .");
      expect(ruff?.category).toBe("lint");
      expect(ruff?.evidence).toContain("pyproject.toml [tool.ruff]");
      expect(file.intel).toBe(intel);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns incomplete (never a generic gate) when no evidence was found", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-qg-empty-"));
    try {
      const intel = await gatherProjectIntel(tmp);
      const file = synthesizeGateFromIntel(intel);
      expect(file.status).toBe("incomplete");
      expect(file.checks).toEqual([]);
      expect(file.needsResolution?.length).toBeGreaterThan(0);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("synthesizeGateFromIntel docs/CI evidence", () => {
  // A minimal intel with no evidence in any bucket, reused as the base for the
  // docs/CI-only scenarios below.
  const emptyIntel: ProjectIntel = {
    repoPath: "/repo",
    markers: [],
    commands: [],
    docs: [],
    ci: [],
    summary: []
  };

  it("builds a ready config from CI run steps when no manifest commands exist", () => {
    const intel: ProjectIntel = {
      ...emptyIntel,
      ci: [
        { command: "npm test", category: "test", source: "CI ci.yml run step" },
        { command: "npm run build", category: "build", source: "CI ci.yml run step" }
      ]
    };
    const file = synthesizeGateFromIntel(intel);
    expect(file.status).toBe("ready");
    const cmds = file.checks.map((c) => c.command);
    expect(cmds).toContain("npm test");
    expect(cmds).toContain("npm run build");
    // The CI provenance is carried as evidence so the source is transparent.
    expect(file.checks.find((c) => c.command === "npm test")?.evidence).toContain(
      "CI ci.yml run step"
    );
  });

  it("builds a ready config from doc excerpts (README-only repo)", () => {
    const intel: ProjectIntel = {
      ...emptyIntel,
      docs: [{ path: "README.md", commands: ["npm test", "npm run build"] }]
    };
    const file = synthesizeGateFromIntel(intel);
    expect(file.status).toBe("ready");
    const cmds = file.checks.map((c) => c.command);
    expect(cmds).toContain("npm test");
    expect(cmds).toContain("npm run build");
    expect(file.checks.find((c) => c.command === "npm run build")?.evidence).toContain(
      "docs README.md"
    );
  });

  it("drops shell-chain docs/CI commands (same direct-invocation vetting as agent output)", () => {
    // A README whose only test line is a chain cannot run as a single direct spawn
    // (the executor would silently run only the first stage), so it must not be
    // emitted. With no other evidence, the gate stays incomplete rather than
    // persisting a command that would mis-run.
    const intel: ProjectIntel = {
      ...emptyIntel,
      docs: [{ path: "README.md", commands: ["npm run lint && npm run test"] }]
    };
    const file = synthesizeGateFromIntel(intel);
    expect(file.status).toBe("incomplete");
    expect(file.checks).toEqual([]);
  });

  it("drops dependency-setup CI commands instead of persisting them as required checks", () => {
    // `npm ci` infers to category "other" (no tool token matches), so without this
    // guard it would resolve required=true and become a network-dependent check
    // that runs every turn and fails spuriously on registry issues. Setup commands
    // verify nothing, so only the real test step survives.
    const intel: ProjectIntel = {
      ...emptyIntel,
      ci: [
        { command: "npm ci", category: "other", source: "CI ci.yml run step" },
        { command: "npm test", category: "test", source: "CI ci.yml run step" }
      ]
    };
    const file = synthesizeGateFromIntel(intel);
    expect(file.status).toBe("ready");
    const cmds = file.checks.map((c) => c.command);
    expect(cmds).not.toContain("npm ci");
    expect(cmds).toContain("npm test");
  });

  it("stays incomplete when the only CI evidence is a dependency-setup command", () => {
    // With only an install step and nothing to verify, the gate must not fabricate
    // a required check; it reports the gap instead (verify, don't mutate).
    const intel: ProjectIntel = {
      ...emptyIntel,
      ci: [{ command: "npm ci", category: "other", source: "CI ci.yml run step" }]
    };
    const file = synthesizeGateFromIntel(intel);
    expect(file.status).toBe("incomplete");
    expect(file.checks).toEqual([]);
  });

  it("drops release/deploy commands instead of persisting them as checks", () => {
    // publish/deploy/serve/release mutate published state or hit the network, so by
    // the verify-don't-mutate invariant they must never become a persisted check
    // (advisory or required). They infer to category "other" (no tool token matches),
    // so without this guard each would otherwise survive. Only the real test step
    // persists.
    const intel: ProjectIntel = {
      ...emptyIntel,
      ci: [
        { command: "npm publish", category: "other", source: "CI ci.yml run step" },
        { command: "make deploy", category: "other", source: "CI ci.yml run step" },
        { command: "make release", category: "other", source: "CI ci.yml run step" },
        { command: "npm test", category: "test", source: "CI ci.yml run step" }
      ]
    };
    const file = synthesizeGateFromIntel(intel);
    expect(file.status).toBe("ready");
    const cmds = file.checks.map((c) => c.command);
    expect(cmds).not.toContain("npm publish");
    expect(cmds).not.toContain("make deploy");
    expect(cmds).not.toContain("make release");
    expect(cmds).toContain("npm test");
  });

  it("emits non-verification ('other') commands as advisory, never blocking", () => {
    // An unrecognized command is not a known verification step, so the gate must not
    // block on it (we cannot tell what it does). It is still recorded as advisory so
    // the agent/operator can promote it to a real category; only lint/test/typecheck/
    // build/security may be required.
    const intel: ProjectIntel = {
      ...emptyIntel,
      docs: [{ path: "README.md", commands: ["./scripts/smoke.sh"] }]
    };
    const file = synthesizeGateFromIntel(intel);
    expect(file.status).toBe("ready");
    const other = file.checks.find((c) => c.command === "./scripts/smoke.sh");
    expect(other?.category).toBe("other");
    expect(other?.required).toBe(false);
  });

  it("dedupes a command shared by manifests and CI, keeping the higher-confidence source", () => {
    // Manifests/Makefile are higher confidence than CI; both are processed, so the
    // first occurrence (manifest) wins and the CI duplicate is dropped.
    const intel: ProjectIntel = {
      ...emptyIntel,
      commands: [
        { command: "npm run -s test", category: "test", source: "package.json script `test`" }
      ],
      ci: [{ command: "npm run -s test", category: "test", source: "CI ci.yml run step" }]
    };
    const file = synthesizeGateFromIntel(intel);
    expect(file.status).toBe("ready");
    const matches = file.checks.filter((c) => c.command === "npm run -s test");
    expect(matches.length).toBe(1);
    expect(matches[0]?.evidence).toContain("package.json script `test`");
  });
});

describe("isMutatingCommand", () => {
  // Commands that acquire dependencies OR publish/deploy/serve/release mutate state
  // or hit the network instead of verifying behaviour, so the gate (verify, don't
  // mutate) must never persist them as a check. The predicate classifies the common
  // install/fetch forms and the release/deploy verbs; mvn/gradle `install` are
  // excluded because those run the test suite (a real verify command).
  it.each<[command: string, expected: boolean]>([
    ["npm ci", true],
    ["npm install", true],
    ["npm install --no-audit --no-fund", true],
    ["npm i", true],
    ["npm add left-pad", true],
    ["yarn install", true],
    ["pnpm install", true],
    ["bun install", true],
    ["bun add foo", true],
    ["pip install -r requirements.txt", true],
    ["uv sync", true],
    ["uv pip install pkg", true],
    ["poetry install", true],
    ["bundle install", true],
    ["gem install rspec", true],
    ["composer install", true],
    ["cargo fetch", true],
    ["cargo add serde", true],
    ["dotnet restore", true],
    ["go mod download", true],
    ["go get example.com/pkg", true],
    ["flutter pub get", true],
    ["make install", true],
    ["make deps", true],
    // release/deploy verbs: publish, ship, or run externally rather than verify
    ["npm publish", true],
    ["npm run publish", true],
    ["npm run deploy", true],
    ["npm run serve", true],
    ["npm run release", true],
    ["npm publish --access public", true],
    ["yarn publish", true],
    ["pnpm publish", true],
    ["bun publish", true],
    ["make publish", true],
    ["make deploy", true],
    ["make serve", true],
    ["make release", true],
    ["make ship", true],
    ["make distribute", true],
    ["make release stable", true],
    ["cargo publish", true],
    ["mvn deploy", true],
    ["gradle publish", true],
    // verify commands and bare test/build/lint invocations are NOT mutating
    ["npm test", false],
    ["npm run build", false],
    ["npm run -s lint", false],
    ["npm run install", false],
    ["uv run pytest", false],
    ["cargo build", false],
    ["go test ./...", false],
    ["make test", false],
    ["dotnet test", false],
    ["ruff check .", false],
    ["pytest", false],
    // a release/deploy *token* that is part of a larger target is NOT a release verb:
    // `cargo build --release` is a build, `make release-notes` / `npm run deploy-tests`
    // are bespoke targets, not publish/deploy steps.
    ["cargo build --release", false],
    ["make release-notes", false],
    ["npm run deploy-tests", false],
    // mvn/gradle install run the test suite -> intentionally NOT classified as mutating
    ["mvn install", false],
    ["gradle install", false]
  ])("classifies %s as %s", (command, expected) => {
    expect(isMutatingCommand(command)).toBe(expected);
  });
});

describe("isVerificationCategory", () => {
  // Only known verification categories may block the gate; format and the catch-all
  // "other" are advisory (we don't block on a command whose effect we can't pin down).
  it.each<[category: string, expected: boolean]>([
    ["lint", true],
    ["test", true],
    ["typecheck", true],
    ["build", true],
    ["security", true],
    ["format", false],
    ["other", false]
  ])("classifies %s as %s", (category, expected) => {
    expect(isVerificationCategory(category as never)).toBe(expected);
  });
});

describe("parseAndValidateQualityGate", () => {
  it("accepts a valid ready object with evidence", () => {
    const result = parseAndValidateQualityGate(READY_RUFF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.status).toBe("ready");
      expect(result.file.checks[0]!.evidence).toContain("pyproject.toml [tool.ruff]");
    }
  });

  it("accepts output wrapped in a ```json fence", () => {
    const result = parseAndValidateQualityGate("```json\n" + READY_RUFF + "\n```");
    expect(result.ok).toBe(true);
  });

  it("rejects a ready config with no evidence-backed checks (no generic fallback)", () => {
    const bad = JSON.stringify({
      status: "ready",
      checks: [{ name: "lint", category: "lint", command: "echo lint", required: true }]
      // no evidence -> dropped -> ready with zero checks -> rejected
    });
    const result = parseAndValidateQualityGate(bad);
    expect(result.ok).toBe(false);
  });

  it("accepts an incomplete config that names its gaps", () => {
    const result = parseAndValidateQualityGate(
      JSON.stringify({ status: "incomplete", checks: [], needsResolution: ["No test runner declared."] })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an incomplete config without needsResolution", () => {
    const result = parseAndValidateQualityGate(JSON.stringify({ status: "incomplete", checks: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid status", () => {
    const result = parseAndValidateQualityGate(JSON.stringify({ status: "maybe", checks: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects non-JSON output", () => {
    const result = parseAndValidateQualityGate("I think you should run pytest");
    expect(result.ok).toBe(false);
  });
});

/** A ready config carrying a single lint check with an optional workingDirectory. */
function readyCheckWith(workingDirectory?: string): string {
  const check: Record<string, unknown> = {
    name: "lint",
    category: "lint",
    command: "ruff check .",
    required: true,
    evidence: ["pyproject.toml [tool.ruff]"]
  };
  if (workingDirectory !== undefined) check["workingDirectory"] = workingDirectory;
  return JSON.stringify({ status: "ready", checks: [check], rationale: "Ruff in pyproject.toml." });
}

describe("parseAndValidateQualityGate workingDirectory containment", () => {
  it("keeps a safe relative working directory", () => {
    const result = parseAndValidateQualityGate(readyCheckWith("packages/web"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBe("packages/web");
  });

  it("keeps an interior .. that folds back inside the repo", () => {
    // a/../b normalizes to b, which stays inside the repo root.
    const result = parseAndValidateQualityGate(readyCheckWith("a/../b"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBe("a/../b");
  });

  it("drops an absolute working directory so the check runs from the repo root", () => {
    const result = parseAndValidateQualityGate(readyCheckWith("/etc"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBeUndefined();
  });

  it("drops a working directory that escapes the repo via ..", () => {
    const result = parseAndValidateQualityGate(readyCheckWith("../sibling"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBeUndefined();
  });

  it("drops a deeper traversal that normalizes outside the repo", () => {
    // a/../../escape normalizes to ../escape, which escapes the root.
    const result = parseAndValidateQualityGate(readyCheckWith("a/../../escape"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBeUndefined();
  });
});

/** A ready config carrying one check with an arbitrary command and evidence. */
function readyWithCommand(command: string): string {
  return JSON.stringify({
    status: "ready",
    checks: [{ name: "x", category: "test", command, required: true, evidence: ["repo"] }],
    rationale: "x"
  });
}

describe("parseAndValidateQualityGate shell-syntax contract", () => {
  // The check executor spawns each command directly (shell: false), so a command
  // that relies on shell operators cannot run correctly: `a && b` runs only `a`
  // (with `&&`, `b` as junk argv), `cd x && c` fails to spawn the `cd` builtin,
  // and pipes/redirections/substitution are passed as literal argv. Such commands
  // must be rejected at the persistence boundary rather than stored to mis-run.
  it("rejects a command that chains stages with &&", () => {
    const result = parseAndValidateQualityGate(readyWithCommand("npm run lint && npm run test"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/&&/);
  });

  it("rejects a piped command", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("pytest | tee out.txt")).ok).toBe(false);
  });

  it("rejects a cd-prefixed command", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("cd packages/api && npm test")).ok).toBe(false);
  });

  it("rejects a bare leading cd with no shell operator to catch it", () => {
    // `cd` is a shell builtin: spawned directly it cannot change the executor's
    // directory, so a leading `cd subdir` must use workingDirectory instead. The
    // validator's own rejection message promises this, so a bare `cd` (no && or |
    // to trip the operator scan) must still be rejected on its own.
    const result = parseAndValidateQualityGate(readyWithCommand("cd packages/api"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/\bcd\b/);
  });

  it("rejects a redirection", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("make test > build.log")).ok).toBe(false);
  });

  it("rejects a leading NAME=value env assignment", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("NODE_ENV=test npm test")).ok).toBe(false);
  });

  it("accepts a NAME=value argument that is not a leading env assignment", () => {
    // `make test VAR=1` passes VAR=1 as a make argument; only a LEADING assignment
    // (before the program) is shell env syntax the executor cannot honour.
    expect(parseAndValidateQualityGate(readyWithCommand("make test VAR=1")).ok).toBe(true);
  });

  it("accepts a shell operator inside a quoted argument (a literal, not an operator)", () => {
    expect(parseAndValidateQualityGate(readyWithCommand('./check.sh --label "a && b"')).ok).toBe(true);
  });

  it("accepts a clean multi-argument command", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("ruff check --select E,F src/")).ok).toBe(true);
  });
});

/** A ready config carrying one check with an arbitrary command/category/required. */
function readyCheck(command: string, category: string, required: boolean): string {
  return JSON.stringify({
    status: "ready",
    checks: [{ name: "x", category, command, required, evidence: ["repo"] }],
    rationale: "x"
  });
}

describe("parseAndValidateQualityGate verify-don't-mutate", () => {
  // The gate verifies; it must never persist a mutating/network command or an
  // unrecognized command as a blocking check, regardless of what the agent claims.
  // A non-verification or mutating command is coerced to advisory (required: false)
  // rather than rejected, so one over-eager check cannot discard a whole response.
  it("coerces a release command (category other) to advisory", () => {
    const result = parseAndValidateQualityGate(readyCheck("npm publish", "other", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a mutating command even when the agent mis-categorizes it as verification", () => {
    // The agent labels `npm publish` as "build" and required. Category alone would
    // let it block; the command-text guard must still demote it to advisory so it
    // never runs (and never mutates published state) every turn.
    const result = parseAndValidateQualityGate(readyCheck("npm publish", "build", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a deploy command mis-categorized as test to advisory", () => {
    const result = parseAndValidateQualityGate(readyCheck("make deploy", "test", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a non-verification 'other' command to advisory", () => {
    const result = parseAndValidateQualityGate(readyCheck("./scripts/smoke.sh", "other", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a format command to advisory even when the agent marks it required", () => {
    const result = parseAndValidateQualityGate(readyCheck("prettier --check .", "format", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("keeps a genuine verification command required", () => {
    const result = parseAndValidateQualityGate(readyCheck("ruff check .", "lint", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(true);
  });
});

describe("generateProjectQualityGate lifecycle", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-root-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("returns a pending placeholder before generation runs", async () => {
    const file = await readProjectQualityGate(root, project.id);
    expect(file.status).toBe("pending");
    expect(file.checks).toEqual([]);
  });

  it("stores a ready config when the agent returns valid evidence-backed output", async () => {
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    const runner = repliesRunner(READY_RUFF);
    const file = await generateProjectQualityGate(root, project, { runner });

    expect(file.status).toBe("ready");
    expect(file.checks[0]!.command).toBe("ruff check .");
    const stored = await readProjectQualityGate(root, project.id);
    expect(stored.status).toBe("ready");
    expect(stored.generatedAt).toBeTruthy();
    expect(stored.intel).toBeTruthy();
  });

  it("falls back to deterministic synthesis from intel when the agent output is invalid", async () => {
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n[tool.pytest.ini_options]\n", "utf8");
    const runner = repliesRunner("nope, can't help");
    const file = await generateProjectQualityGate(root, project, { runner });

    // Evidence exists in the repo -> a correct per-project gate is synthesized,
    // never a generic one, even though the agent failed.
    expect(file.status).toBe("ready");
    const cmds = file.checks.map((c) => c.command);
    expect(cmds).toContain("ruff check .");
    expect(cmds).toContain("pytest");
    expect(file.rationale).toContain("deterministic");
  });

  it("stores incomplete (not a generic gate) when neither agent nor intel find evidence", async () => {
    const runner = repliesRunner("garbage");
    const file = await generateProjectQualityGate(root, project, { runner });
    expect(file.status).toBe("incomplete");
    expect(file.checks).toEqual([]);
    expect(file.needsResolution?.length).toBeGreaterThan(0);
  });

  it("synthesizes a ready gate from README docs when the agent fails (README-only repo)", async () => {
    // No manifest/Makefile/CI: the only evidence is fenced commands in the README.
    // The agent fails, so deterministic synthesis must fold the docs evidence into a
    // ready gate rather than marking the repo incomplete with no checks (the prior
    // fallback only inspected manifest commands and so missed docs-only repos).
    await writeFile(
      path.join(repo, "README.md"),
      "# Project\n\n## Usage\n\n```sh\nnpm test\nnpm run build\n```\n",
      "utf8"
    );
    const runner = repliesRunner("nope, can't help");
    const file = await generateProjectQualityGate(root, project, { runner });

    expect(file.status).toBe("ready");
    const cmds = file.checks.map((c) => c.command);
    expect(cmds).toContain("npm test");
    expect(cmds).toContain("npm run build");
  });

  it("returns the same stamped config it persists on success (matches a later GET)", async () => {
    // The wait-mode regenerate route serializes this return value straight to the
    // HTTP response, while a subsequent GET reads the persisted file. They must be
    // identical, so the returned object carries the same generatedAt/repoPath/intel
    // that were written — not the raw, unstamped agent output.
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    const runner = repliesRunner(READY_RUFF);
    const file = await generateProjectQualityGate(root, project, { runner });

    const stored = await readProjectQualityGate(root, project.id);
    expect(file).toEqual(stored);
    expect(file.generatedAt).toBeTruthy();
    expect(file.repoPath).toBe(project.repoPath);
    expect(file.intel).toBeTruthy();
  });

  it("returns the same stamped config it persists on fallback (carries the amended rationale)", async () => {
    // The fallback path amends the rationale and stamps the file before writing.
    // The return value must reflect those same amendments, not the pre-amendment
    // synthesis object the caller would otherwise receive.
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n[tool.pytest.ini_options]\n", "utf8");
    const runner = repliesRunner("nope, can't help");
    const file = await generateProjectQualityGate(root, project, { runner });

    const stored = await readProjectQualityGate(root, project.id);
    expect(file).toEqual(stored);
    expect(file.rationale).toContain("deterministic");
    expect(file.intel).toBeTruthy();
    expect(file.generatedAt).toBeTruthy();
  });
});

describe("planProjectChecks workingDirectory containment", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-cwd-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("does not set PlannedCheck.cwd for an unsafe working directory stored on disk", async () => {
    // Stored configs are re-read with only a loose shape check, so the
    // containment guard must hold at the planning boundary, not just at parse.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        {
          name: "lint",
          category: "lint",
          command: "ruff check .",
          required: true,
          evidence: ["pyproject.toml"],
          workingDirectory: "/etc"
        }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    const check = plan.checks.find((c) => c.name === "lint");
    expect(check).toBeTruthy();
    expect(check!.cwd).toBeUndefined();
  });

  it("sets PlannedCheck.cwd for a safe relative working directory", async () => {
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        {
          name: "lint",
          category: "lint",
          command: "ruff check .",
          required: true,
          evidence: ["pyproject.toml"],
          workingDirectory: "packages/web"
        }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    const check = plan.checks.find((c) => c.name === "lint");
    expect(check!.cwd).toBe("packages/web");
  });
});

describe("planProjectChecks shell-syntax guard", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-shell-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("surfaces a stored shell-style command as an explicit skip, never silently mis-runs it", async () => {
    // Stored configs are re-read with only a loose shape check, so the shell-syntax
    // contract is enforced at the plan boundary too: a command the direct-spawn
    // executor cannot run becomes an unavailable check with a reason, rather than
    // being spawned and running only its first stage.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        {
          name: "ci",
          category: "test",
          command: "npm run lint && npm run test",
          required: true,
          evidence: [".github/workflows/ci.yml"]
        }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    const check = plan.checks.find((c) => c.name === "ci");
    expect(check?.available).toBe(false);
    expect(check?.skipReason).toMatch(/shell syntax/);
  });
});

describe("planProjectChecks verify-don't-mutate guard", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-mutate-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("does not block on a stored mutating command, even mis-categorized as verification", async () => {
    // Stored configs are re-read with only a loose shape check, so a pre-fix config
    // (or a hand-edited one) may carry `npm publish` as required:true under any
    // category. The plan boundary must re-enforce verify-don't-mutate so it never
    // reaches the executor: nothing is planned, the gate does not block on it.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        { name: "publish", category: "build", command: "npm publish", required: true, evidence: ["CI"] },
        { name: "deploy", category: "test", command: "make deploy", required: true, evidence: ["CI"] }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    expect(plan.checks).toEqual([]);
  });

  it("does not block on a stored 'other' command marked required", async () => {
    // An unrecognized command marked required (e.g. left by the pre-fix synthesis,
    // which made every non-format category required) must not block: only known
    // verification categories may drive the gate.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        { name: "smoke", category: "other", command: "./scripts/smoke.sh", required: true, evidence: ["README.md"] }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    expect(plan.checks).toEqual([]);
  });

  it("still blocks on a genuine verification check alongside mutating ones", async () => {
    // A real lint check survives the guard while the mutating sibling is dropped,
    // so the gate keeps verifying without running the publish/deploy step.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        { name: "publish", category: "build", command: "npm publish", required: true, evidence: ["CI"] },
        { name: "lint", category: "lint", command: "ruff check .", required: true, evidence: ["pyproject.toml"] }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    const names = plan.checks.map((c) => c.name);
    expect(names).toContain("lint");
    expect(names).not.toContain("publish");
  });
});
